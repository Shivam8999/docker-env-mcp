import Docker from "dockerode";
import { checkDockerConnection, execCommand } from "../docker.js";

export interface ExecContainerOptions {
  containerId: string;
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecContainerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a command inside an already running container and returns stdout, stderr, and exit code.
 */
export async function execInContainer(
  docker: Docker,
  options: ExecContainerOptions
): Promise<ExecContainerResult> {
  await checkDockerConnection(docker);

  const container = docker.getContainer(options.containerId);
  const inspect = await container.inspect().catch((err) => {
    throw new Error(`Failed to find container with ID or name '${options.containerId}': ${err.message}`);
  });

  if (!inspect.State.Running) {
    throw new Error(`Container '${options.containerId}' is not running (State: ${inspect.State.Status})`);
  }

  const envArray = options.env
    ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
    : undefined;

  const result = await execCommand(docker, container, ["sh", "-c", options.command], {
    workdir: options.workdir,
    env: envArray,
    timeoutMs: options.timeoutMs ?? 60000,
  });

  return result;
}
