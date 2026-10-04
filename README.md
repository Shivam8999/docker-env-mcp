# Docker Environment MCP Server

A Model Context Protocol (MCP) server that empowers AI agents to seamlessly orchestrate and interact with Docker environments while eliminating boilerplate commands.

Strictly built and validated to run on **Node.js 24**.

---

## Features & Endpoints

### 1. `start_project_container`
Launches or hot-syncs a Docker container for a given project directory, with smart dependency and environment caching.

* **Relative / Absolute Inputs**: Specify paths like `'./my-app'` or `'../client'`.
* **Port Mappings**: Support for flexible port mapping (`['3000:3000']`, `['8080:80/tcp']`, or `[{ hostPort: 3000, containerPort: 3000 }]`).
* **Environment Files**: Accepts `.env` files and explicit variables, automatically injected into the container.
* **Smart Caching & Hot-Sync**:
  * Computes SHA-256 hashes of dependency files (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, etc.) and environment configurations.
  * If a container is already running for the project and **neither dependencies nor env have changed**, it avoids container recreation. Instead, it copies updated files into the running container and restarts the server process.
* **Persistent Servers**: Runs application servers in the background and returns the `containerId` immediately with initial startup logs.

> **Important Usage Recommendation**:
> If your project requires dependencies to run, include the dependency installation step directly in the command (e.g., `npm install && npm start` or `pip install -r requirements.txt && python app.py`). On hot-sync restarts (when dependencies are unchanged), use `restartCommand` (e.g., `npm start`) or let it re-run without reinstallation.

---

### 2. `exec_in_container`
Executes a command inside an already running container and returns stdout, stderr, and the exit code.

* **Parameters**:
  * `containerId`: ID or name of the running container.
  * `command`: Shell command to run (e.g. `'ls -la'`, `'npm test'`, `'curl http://localhost:3000'`).
  * `workdir` *(optional)*: Working directory inside container.
  * `env` *(optional)*: Custom environment variables.
  * `timeoutMs` *(optional)*: Maximum execution duration before timing out (default: 60s).

---

### 3. `run_and_destroy_container`
Starts an ephemeral container, optionally copies project files into it, runs a command to completion, captures stdout/stderr/exitCode, and automatically destroys the container.

* **Parameters**:
  * `image`: Docker image (e.g., `'node:24-alpine'`, `'python:3.11-alpine'`, `'ubuntu:latest'`).
  * `command`: Command to run.
  * `folderPath` *(optional)*: Local project folder to copy into the container before running.
  * `workdir` *(optional)*: Working directory in container (default: `'/app'`).
  * `env` *(optional)*: Custom environment variables.
  * `timeoutMs` *(optional)*: Timeout duration (default: 120s).

---

### 4. Container Management Tools
* `list_containers`: Lists active/all containers with project links and port bindings.
* `stop_project_container`: Gracefully stops and optionally destroys a project container by ID or project path.
* `get_container_logs`: Fetches application server logs (`server.log`) or Docker stdout/stderr streams.

---

## Requirements

* **Node.js 24** (enforced at runtime, in `package.json` engines, and npm scripts).
* **Docker Engine / Docker Desktop** must be installed and running on your machine. You can download it from [docker.com](https://www.docker.com/products/docker-desktop/).

---

## Installation

### Method 1 — Direct Installation (Recommended)

Install the package globally from npm:

```bash
npm install -g @shivam8999/docker-env-mcp
```

Once installed, configure your MCP client to use the server (see [MCP Client Configuration](#mcp-client-configuration-example) below).

### Method 2 — Build from Source

Clone the repository and build it yourself:

```bash
git clone https://github.com/Shivam8999/docker-env-mcp.git
cd docker-env-mcp
npm install
npm run build
```

Then point your MCP client to the local build:

```json
{
  "mcpServers": {
    "docker-env": {
      "command": "node",
      "args": ["/path/to/docker-env-mcp/dist/index.js"]
    }
  }
}
```

#### Available Scripts

```bash
npm run build    # Build TypeScript to dist/
npm start        # Start MCP Server on stdio
npm run dev      # Run in development mode with tsx
npm test         # Run unit tests
```

---

## MCP Client Configuration Example

To use this server in Claude Desktop, Cursor, or Antigravity MCP settings:

```json
{
  "mcpServers": {
    "docker-env": {
      "command": "npx",
      "args": ["-y", "@shivam8999/docker-env-mcp"]
    }
  }
}
```
