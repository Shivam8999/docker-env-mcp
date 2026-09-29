import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDockerClient } from "./docker.js";
import {
  getContainerLogs,
  listProjectContainers,
  stopProjectContainer,
} from "./tools/containerManage.js";
import { execInContainer } from "./tools/execContainer.js";
import { runAndDestroyContainer } from "./tools/runAndDestroy.js";
import { startProjectContainer } from "./tools/startProject.js";

// Strict Node 24 enforcement
const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor !== 24) {
  console.error(
    `Error: This project strictly requires Node.js 24. Currently running on Node.js ${process.version}`
  );
  process.exit(1);
}

const docker = getDockerClient();

const server = new McpServer({
  name: "docker-env-server",
  version: "1.0.0",
});

// 1. START / SMART-SYNC PROJECT CONTAINER
server.tool(
  "start_project_container",
  `Starts a Docker container for a project directory, copies files into the container, and runs a command (keeping servers running in the background).

RECOMMENDATION:
If you want to run a project with dependencies, your command should include the dependency installation command (e.g. 'npm install && npm start' or 'pip install -r requirements.txt && python app.py').

SMART CACHING & HOT-SYNC:
If a container is already running for the project and neither the dependencies (package.json, requirements.txt, go.mod, etc.) nor environment files/variables have changed (verified via SHA-256 hash checks), files are copied directly into the running container and the server process is restarted without rebuilding or recreating the container.`,
  {
    folderPath: z
      .string()
      .describe(
        "Relative or absolute path to the local project folder (e.g., './my-app' or '../project')"
      ),
    command: z
      .string()
      .describe(
        "Command to execute inside the container (e.g., 'npm install && npm start'). Should include dependency installation if needed."
      ),
    restartCommand: z
      .string()
      .optional()
      .describe(
        "Optional command to run when restarting the server on hot-sync when dependencies have not changed (e.g., 'npm start'). If omitted, runs 'command'."
      ),
    image: z
      .string()
      .optional()
      .describe(
        "Base Docker image to use (e.g., 'node:24-alpine', 'python:3.11-alpine'). Automatically detected if omitted."
      ),
    containerWorkdir: z
      .string()
      .optional()
      .default("/app")
      .describe("Working directory path inside the container (default: '/app')"),
    portMappings: z
      .array(
        z.union([
          z.string().describe("Port mapping string like '3000:3000' or '8080:80/tcp'"),
          z.object({
            hostPort: z.number().describe("Port on host machine"),
            containerPort: z.number().describe("Port in container"),
            protocol: z.enum(["tcp", "udp"]).optional().describe("tcp or udp (default tcp)"),
            hostIp: z.string().optional().describe("Host IP (default 0.0.0.0)"),
          }),
        ])
      )
      .optional()
      .describe("Port mappings, e.g. ['3000:3000'] or [{ hostPort: 3000, containerPort: 3000 }]"),
    envFiles: z
      .array(z.string())
      .optional()
      .describe("List of relative or absolute paths to .env files to load into the container"),
    envVars: z
      .record(z.string(), z.string())
      .optional()
      .describe("Dictionary of additional environment variables to pass into the container"),
  },
  async (args) => {
    try {
      const result = await startProjectContainer(docker, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error starting project container: ${msg}` }],
      };
    }
  }
);

// 2. RUN COMMAND IN EXISTING CONTAINER
server.tool(
  "exec_in_container",
  "Runs a command inside an already running Docker container and returns stdout, stderr, and exit code.",
  {
    containerId: z
      .string()
      .describe("Container ID or name of the already running container"),
    command: z
      .string()
      .describe("Shell command to execute inside the container (e.g. 'ls -la' or 'npm test')"),
    workdir: z
      .string()
      .optional()
      .describe("Working directory inside the container for this command (default: container workdir)"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional environment variables for this command execution"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 60000)"),
  },
  async (args) => {
    try {
      const result = await execInContainer(docker, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error running command in container: ${msg}` }],
      };
    }
  }
);

// 3. START CONTAINER -> RUN COMMAND -> DESTROY CONTAINER
server.tool(
  "run_and_destroy_container",
  "Starts an ephemeral container, optionally copies project files into it, runs a command to completion, returns stdout/stderr/exitCode, and destroys the container.",
  {
    image: z
      .string()
      .describe("Docker image to run (e.g., 'node:24-alpine', 'alpine:latest', 'python:3.11-alpine')"),
    command: z
      .string()
      .describe("Command to run inside the ephemeral container"),
    folderPath: z
      .string()
      .optional()
      .describe("Optional relative or absolute path of a folder to copy into the container before running"),
    workdir: z
      .string()
      .optional()
      .default("/app")
      .describe("Working directory in the container (default: '/app')"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables to set in the container"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Timeout in milliseconds before terminating (default: 120000)"),
  },
  async (args) => {
    try {
      const result = await runAndDestroyContainer(docker, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error in ephemeral container: ${msg}` }],
      };
    }
  }
);

// 4. LIST CONTAINERS
server.tool(
  "list_containers",
  "Lists Docker containers, including status, port bindings, and project links.",
  {
    all: z
      .boolean()
      .optional()
      .default(false)
      .describe("Show all containers (default shows only running)"),
  },
  async (args) => {
    try {
      const result = await listProjectContainers(docker, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error listing containers: ${msg}` }],
      };
    }
  }
);

// 5. STOP / REMOVE PROJECT CONTAINER
server.tool(
  "stop_project_container",
  "Stops and optionally removes a project container by containerId or project folder path.",
  {
    containerId: z
      .string()
      .optional()
      .describe("Container ID to stop"),
    folderPath: z
      .string()
      .optional()
      .describe("Relative or absolute project folder path whose container should be stopped"),
    remove: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to remove the container after stopping (default: true)"),
  },
  async (args) => {
    try {
      const result = await stopProjectContainer(docker, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error stopping container: ${msg}` }],
      };
    }
  }
);

// 6. GET CONTAINER LOGS
server.tool(
  "get_container_logs",
  "Fetches application server logs (server.log) or standard Docker container stdout/stderr.",
  {
    containerId: z.string().describe("Container ID or name"),
    tail: z.number().optional().default(100).describe("Number of log lines from the end (default 100)"),
  },
  async (args) => {
    try {
      const result = await getContainerLogs(docker, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error getting container logs: ${msg}` }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Docker MCP Server running on stdio (Node 24 enforced)");
}

main().catch((err) => {
  console.error("Fatal error starting Docker MCP server:", err);
  process.exit(1);
});
