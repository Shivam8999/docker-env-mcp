import Docker from "dockerode";
import path from "node:path";
import { PassThrough } from "node:stream";
import tar from "tar-fs";

export interface PortConfig {
  hostPort: number;
  containerPort: number;
  protocol?: "tcp" | "udp";
  hostIp?: string;
}

export type PortMappingInput = string | PortConfig;

/**
 * Creates and returns a configured Dockerode instance.
 */
export function getDockerClient(): Docker {
  if (process.env.DOCKER_HOST) {
    return new Docker();
  }

  const isWindows = process.platform === "win32";
  if (isWindows) {
    return new Docker({ socketPath: "//./pipe/docker_engine" });
  }

  return new Docker({ socketPath: "/var/run/docker.sock" });
}

/**
 * Verifies connectivity to the Docker daemon.
 */
export async function checkDockerConnection(docker: Docker): Promise<void> {
  try {
    await docker.ping();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot connect to Docker daemon: ${msg}. Please ensure Docker Desktop/Engine is running.`
    );
  }
}

/**
 * Parses user port mappings into Docker ExposedPorts and HostConfig.PortBindings.
 */
export function parsePortMappings(ports: PortMappingInput[] = []): {
  ExposedPorts: Record<string, object>;
  PortBindings: Record<string, Array<{ HostPort: string; HostIp?: string }>>;
} {
  const ExposedPorts: Record<string, object> = {};
  const PortBindings: Record<string, Array<{ HostPort: string; HostIp?: string }>> = {};

  for (const item of ports) {
    let hostPort: number;
    let containerPort: number;
    let protocol: "tcp" | "udp" = "tcp";
    let hostIp = "0.0.0.0";

    if (typeof item === "string") {
      // Formats: "3000:3000", "8080:80/tcp", "127.0.0.1:8080:80", "3000"
      let clean = item.trim();
      if (clean.includes("/")) {
        const [p, proto] = clean.split("/");
        clean = p;
        if (proto.toLowerCase() === "udp") {
          protocol = "udp";
        }
      }

      const parts = clean.split(":");
      if (parts.length === 1) {
        hostPort = parseInt(parts[0], 10);
        containerPort = hostPort;
      } else if (parts.length === 2) {
        hostPort = parseInt(parts[0], 10);
        containerPort = parseInt(parts[1], 10);
      } else if (parts.length === 3) {
        hostIp = parts[0];
        hostPort = parseInt(parts[1], 10);
        containerPort = parseInt(parts[2], 10);
      } else {
        throw new Error(`Invalid port format: ${item}`);
      }
    } else {
      hostPort = item.hostPort;
      containerPort = item.containerPort;
      if (item.protocol) {
        protocol = item.protocol;
      }
      if (item.hostIp) {
        hostIp = item.hostIp;
      }
    }

    if (isNaN(hostPort) || isNaN(containerPort)) {
      throw new Error(`Invalid port numbers in: ${JSON.stringify(item)}`);
    }

    const portKey = `${containerPort}/${protocol}`;
    ExposedPorts[portKey] = {};

    if (!PortBindings[portKey]) {
      PortBindings[portKey] = [];
    }
    PortBindings[portKey].push({
      HostPort: hostPort.toString(),
      HostIp: hostIp,
    });
  }

  return { ExposedPorts, PortBindings };
}

/**
 * Ensures a Docker image is present locally, pulling it if necessary.
 */
export async function ensureImage(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch (err: any) {
    if (err.statusCode === 404 || err.message?.includes("No such image")) {
      console.error(`Image ${image} not found locally. Pulling...`);
      await new Promise<void>((resolve, reject) => {
        docker.pull(image, (pullErr: any, stream: NodeJS.ReadableStream) => {
          if (pullErr) return reject(pullErr);
          docker.modem.followProgress(stream, (followErr: any) => {
            if (followErr) return reject(followErr);
            resolve();
          });
        });
      });
    } else {
      throw err;
    }
  }
}

/**
 * Copies a local folder into a running container via tar archive stream.
 * Automatically ignores host-specific / heavy directories like node_modules and .git.
 */
export async function copyDirToContainer(
  docker: Docker,
  container: Docker.Container,
  srcDir: string,
  destDir: string
): Promise<void> {
  // Ensure the destination directory exists in the container
  await execCommand(docker, container, ["mkdir", "-p", destDir]);

  const pack = tar.pack(srcDir, {
    ignore: (name) => {
      const base = path.basename(name);
      return [
        "node_modules",
        ".git",
        ".venv",
        "venv",
        "__pycache__",
        ".next",
        ".nuxt",
        "dist",
        "build",
        ".cache",
        ".turbo",
        ".DS_Store",
      ].includes(base);
    },
  });

  await container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: destDir });
}

/**
 * Executes a command in an existing container and returns stdout, stderr, and exit code.
 */
export async function execCommand(
  docker: Docker,
  container: Docker.Container,
  cmd: string[],
  options: {
    workdir?: string;
    env?: string[];
    timeoutMs?: number;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: options.workdir,
    Env: options.env,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  let stdout = "";
  let stderr = "";

  stdoutStream.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });

  stderrStream.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  docker.modem.demuxStream(stream, stdoutStream, stderrStream);

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        stream.destroy();
        reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    stream.on("end", () => {
      if (timer) clearTimeout(timer);
      resolve();
    });

    stream.on("error", (err: any) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });

  const inspect = await exec.inspect();
  return {
    stdout,
    stderr,
    exitCode: inspect.ExitCode ?? 0,
  };
}

/**
 * Finds any running or stopped container tagged with a specific project ID.
 */
export async function findProjectContainer(
  docker: Docker,
  projectId: string
): Promise<Docker.ContainerInfo | null> {
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: [`mcp.project.id=${projectId}`],
    },
  });

  return containers.length > 0 ? containers[0] : null;
}
