import Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import {
  checkDockerConnection,
  copyDirToContainer,
  ensureImage,
  execCommand,
} from "../docker.js";

export interface RunAndDestroyOptions {
  image: string;
  command: string;
  folderPath?: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunAndDestroyResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Creates an ephemeral container, optionally copies project files into it,
 * executes the given command, captures output, and automatically destroys the container.
 */
export async function runAndDestroyContainer(
  docker: Docker,
  options: RunAndDestroyOptions
): Promise<RunAndDestroyResult> {
  await checkDockerConnection(docker);

  await ensureImage(docker, options.image);

  const workdir = options.workdir || "/app";
  const envArray = options.env
    ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
    : [];

  const containerName = `mcp-ephemeral-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .substring(2, 7)}`;

  // Create keep-alive container so we can copy files and execute with reliable stream demuxing
  const container = await docker.createContainer({
    name: containerName,
    Image: options.image,
    WorkingDir: workdir,
    Cmd: ["sh", "-c", "trap 'exit 0' SIGTERM; while true; do sleep 1; done"],
    Env: envArray,
  });

  try {
    await container.start();

    // If folderPath is provided, resolve and copy files into the container
    if (options.folderPath) {
      const absPath = path.resolve(process.cwd(), options.folderPath);
      if (!fs.existsSync(absPath)) {
        throw new Error(`Specified folderPath not found: ${options.folderPath} (resolved: ${absPath})`);
      }
      await copyDirToContainer(docker, container, absPath, workdir);
    }

    // Execute the user command and wait for completion
    const result = await execCommand(docker, container, ["sh", "-c", options.command], {
      workdir,
      timeoutMs: options.timeoutMs ?? 120000,
    });

    return result;
  } finally {
    // Guarantee destruction of the container
    try {
      await container.remove({ force: true });
    } catch (cleanupErr) {
      console.warn("Failed to remove ephemeral container:", cleanupErr);
    }
  }
}
