import Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import {
  checkDockerConnection,
  copyDirToContainer,
  ensureImage,
  execCommand,
  findProjectContainer,
  parsePortMappings,
  PortMappingInput,
} from "../docker.js";
import { loadEnvFilesAndVars } from "../env.js";
import { computeDependencyHash, computeEnvHash, computeProjectId } from "../hash.js";

export interface StartProjectOptions {
  folderPath: string;
  command: string;
  restartCommand?: string;
  image?: string;
  containerWorkdir?: string;
  portMappings?: PortMappingInput[];
  envFiles?: string[];
  envVars?: Record<string, string>;
}

export interface StartProjectResult {
  containerId: string;
  status: "created_and_running" | "synced_and_restarted";
  message: string;
  depHash: string;
  envHash: string;
  recentLogs?: string;
}

/**
 * Detects a default Docker image based on project files if none is provided.
 */
function detectDefaultImage(folderPath: string): string {
  if (fs.existsSync(path.join(folderPath, "package.json"))) {
    return "node:24-alpine";
  }
  if (
    fs.existsSync(path.join(folderPath, "requirements.txt")) ||
    fs.existsSync(path.join(folderPath, "pyproject.toml"))
  ) {
    return "python:3.11-alpine";
  }
  if (fs.existsSync(path.join(folderPath, "go.mod"))) {
    return "golang:1.23-alpine";
  }
  if (fs.existsSync(path.join(folderPath, "Cargo.toml"))) {
    return "rust:alpine";
  }
  return "node:24-alpine";
}

/**
 * Starts or hot-syncs a project container.
 */
export async function startProjectContainer(
  docker: Docker,
  options: StartProjectOptions
): Promise<StartProjectResult> {
  await checkDockerConnection(docker);

  // 1. Resolve folder path (supports relative and absolute paths)
  const absFolderPath = path.resolve(process.cwd(), options.folderPath);
  if (!fs.existsSync(absFolderPath)) {
    throw new Error(`Project folder does not exist: ${options.folderPath} (resolved to ${absFolderPath})`);
  }
  const stat = fs.statSync(absFolderPath);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${absFolderPath}`);
  }

  const containerWorkdir = options.containerWorkdir || "/app";

  // 2. Parse Environment variables and files
  const { envRecord, envArray } = loadEnvFilesAndVars(
    absFolderPath,
    options.envFiles || [],
    options.envVars || {}
  );

  // 3. Compute Hashes
  const depHash = computeDependencyHash(absFolderPath);
  const envHash = computeEnvHash(envRecord);
  const projectId = computeProjectId(absFolderPath);

  // 4. Check for existing container for this project
  const existingContainerInfo = await findProjectContainer(docker, projectId);

  if (existingContainerInfo) {
    const existingContainer = docker.getContainer(existingContainerInfo.Id);
    const inspect = await existingContainer.inspect().catch(() => null);

    const isRunning = inspect?.State?.Running === true;
    const existingDepHash = inspect?.Config?.Labels?.["mcp.dep.hash"];
    const existingEnvHash = inspect?.Config?.Labels?.["mcp.env.hash"];

    // SMART SYNC: If container is running and dependencies + env haven't changed:
    if (isRunning && existingDepHash === depHash && existingEnvHash === envHash) {
      // Sync code changes into container
      await copyDirToContainer(docker, existingContainer, absFolderPath, containerWorkdir);

      // Restart the server process inside container
      const cmdToRun = options.restartCommand || options.command;
      const runnerCmd = [
        "sh",
        "-c",
        `cd "${containerWorkdir}" && ` +
          `if [ -f "${containerWorkdir}/.server.pid" ]; then ` +
          `  OLD_PID=$(cat "${containerWorkdir}/.server.pid" 2>/dev/null || true); ` +
          `  if [ -n "$OLD_PID" ]; then kill $OLD_PID 2>/dev/null || true; sleep 1; kill -9 $OLD_PID 2>/dev/null || true; fi; ` +
          `fi; ` +
          `nohup sh -c "${cmdToRun.replace(/"/g, '\\"')}" > "${containerWorkdir}/server.log" 2>&1 & ` +
          `echo $! > "${containerWorkdir}/.server.pid"`,
      ];

      await execCommand(docker, existingContainer, runnerCmd);

      // Brief wait to collect startup logs
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const logResult = await execCommand(docker, existingContainer, [
        "sh",
        "-c",
        `tail -n 25 "${containerWorkdir}/server.log" 2>/dev/null || true`,
      ]);

      return {
        containerId: existingContainerInfo.Id,
        status: "synced_and_restarted",
        message:
          "Code synchronized to running container without rebuilding (dependencies and env unchanged). Server restarted.",
        depHash,
        envHash,
        recentLogs: logResult.stdout.trim(),
      };
    }

    // Otherwise, dependencies or env changed, or container was stopped: remove old container
    try {
      if (isRunning) {
        await existingContainer.stop({ t: 2 });
      }
      await existingContainer.remove({ force: true });
    } catch (err) {
      console.warn("Failed to remove old container cleanly:", err);
    }
  }

  // 5. Create a new container
  const image = options.image || detectDefaultImage(absFolderPath);
  await ensureImage(docker, image);

  const { ExposedPorts, PortBindings } = parsePortMappings(options.portMappings || []);

  const containerName = `mcp-proj-${projectId.substring(0, 8)}-${Date.now().toString(36)}`;

  const container = await docker.createContainer({
    name: containerName,
    Image: image,
    WorkingDir: containerWorkdir,
    Cmd: ["sh", "-c", "trap 'exit 0' SIGTERM; while true; do sleep 1; done"],
    Env: envArray,
    ExposedPorts,
    HostConfig: {
      PortBindings,
      RestartPolicy: { Name: "unless-stopped" },
    },
    Labels: {
      "mcp.project.id": projectId,
      "mcp.project.path": absFolderPath,
      "mcp.dep.hash": depHash,
      "mcp.env.hash": envHash,
      "mcp.command": options.command,
    },
  });

  await container.start();

  // Copy files to container
  await copyDirToContainer(docker, container, absFolderPath, containerWorkdir);

  // Execute the command in the background, logging output and tracking PID
  const runnerCmd = [
    "sh",
    "-c",
    `cd "${containerWorkdir}" && ` +
      `nohup sh -c "${options.command.replace(/"/g, '\\"')}" > "${containerWorkdir}/server.log" 2>&1 & ` +
      `echo $! > "${containerWorkdir}/.server.pid"`,
  ];

  await execCommand(docker, container, runnerCmd);

  // Brief pause to allow the process to initialize and output initial logs
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const logResult = await execCommand(docker, container, [
    "sh",
    "-c",
    `tail -n 25 "${containerWorkdir}/server.log" 2>/dev/null || true`,
  ]);

  return {
    containerId: container.id,
    status: "created_and_running",
    message: "New container created and server process launched in background.",
    depHash,
    envHash,
    recentLogs: logResult.stdout.trim(),
  };
}
