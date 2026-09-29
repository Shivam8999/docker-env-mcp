import Docker from "dockerode";
import path from "node:path";
import { checkDockerConnection, execCommand, findProjectContainer } from "../docker.js";
import { computeProjectId } from "../hash.js";

export async function listProjectContainers(
  docker: Docker,
  options: { all?: boolean } = {}
) {
  await checkDockerConnection(docker);

  const containers = await docker.listContainers({ all: !!options.all });
  return containers.map((c) => ({
    id: c.Id.substring(0, 12),
    fullId: c.Id,
    names: c.Names,
    image: c.Image,
    state: c.State,
    status: c.Status,
    ports: c.Ports,
    projectId: c.Labels["mcp.project.id"] || null,
    projectPath: c.Labels["mcp.project.path"] || null,
  }));
}

export async function stopProjectContainer(
  docker: Docker,
  options: { containerId?: string; folderPath?: string; remove?: boolean }
) {
  await checkDockerConnection(docker);

  let targetId = options.containerId;

  if (!targetId && options.folderPath) {
    const absPath = path.resolve(process.cwd(), options.folderPath);
    const projectId = computeProjectId(absPath);
    const existing = await findProjectContainer(docker, projectId);
    if (!existing) {
      throw new Error(`No container found for project path: ${options.folderPath}`);
    }
    targetId = existing.Id;
  }

  if (!targetId) {
    throw new Error("Must provide either containerId or folderPath");
  }

  const container = docker.getContainer(targetId);
  const inspect = await container.inspect();

  if (inspect.State.Running) {
    await container.stop({ t: 2 });
  }

  if (options.remove) {
    await container.remove({ force: true });
    return {
      containerId: targetId,
      status: "stopped_and_removed",
    };
  }

  return {
    containerId: targetId,
    status: "stopped",
  };
}

export async function getContainerLogs(
  docker: Docker,
  options: { containerId: string; tail?: number }
) {
  await checkDockerConnection(docker);

  const container = docker.getContainer(options.containerId);
  const tail = options.tail || 100;

  // Try reading server.log first (for start_project_container servers)
  try {
    const fileResult = await execCommand(docker, container, [
      "sh",
      "-c",
      `tail -n ${tail} /app/server.log 2>/dev/null || true`,
    ]);
    if (fileResult.stdout.trim()) {
      return {
        source: "server.log",
        logs: fileResult.stdout.trim(),
      };
    }
  } catch {
    // Container might not have /app/server.log or exec failed
  }

  // Fallback to docker container logs
  const logsBuffer = await container.logs({
    stdout: true,
    stderr: true,
    tail,
  });

  return {
    source: "docker_logs",
    logs: logsBuffer.toString("utf8"),
  };
}
