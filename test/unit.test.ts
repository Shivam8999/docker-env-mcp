import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePortMappings } from "../src/docker.js";
import { loadEnvFilesAndVars, parseEnvContent } from "../src/env.js";
import {
  computeDependencyHash,
  computeEnvHash,
  computeProjectId,
} from "../src/hash.js";

test("env parser parses key-value pairs, comments, and quotes", () => {
  const sampleEnv = `
# Comment line
PORT=3000
DATABASE_URL="postgres://user:pass@localhost:5432/db"
NODE_ENV='production'
export SECRET_KEY=abcdef12345
EMPTY_VAL=
`;
  const parsed = parseEnvContent(sampleEnv);
  assert.equal(parsed.PORT, "3000");
  assert.equal(parsed.DATABASE_URL, "postgres://user:pass@localhost:5432/db");
  assert.equal(parsed.NODE_ENV, "production");
  assert.equal(parsed.SECRET_KEY, "abcdef12345");
  assert.equal(parsed.EMPTY_VAL, "");
});

test("loadEnvFilesAndVars merges files and explicit variables", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-env-"));
  const envPath = path.join(tmpDir, ".env");
  fs.writeFileSync(envPath, "FOO=bar\nPORT=3000\n");

  const { envRecord, envArray } = loadEnvFilesAndVars(
    tmpDir,
    [".env"],
    { PORT: "8080", EXTRA: "1" }
  );

  assert.equal(envRecord.FOO, "bar");
  assert.equal(envRecord.PORT, "8080"); // explicit var overrides file
  assert.equal(envRecord.EXTRA, "1");
  assert.ok(envArray.includes("PORT=8080"));
  assert.ok(envArray.includes("FOO=bar"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("computeDependencyHash detects dependency changes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-dep-"));
  const pkgJsonPath = path.join(tmpDir, "package.json");

  fs.writeFileSync(pkgJsonPath, JSON.stringify({ dependencies: { express: "^4.18.2" } }));
  const hash1 = computeDependencyHash(tmpDir);

  // Same content should yield same hash
  const hash2 = computeDependencyHash(tmpDir);
  assert.equal(hash1, hash2);

  // Changing dependency should produce different hash
  fs.writeFileSync(pkgJsonPath, JSON.stringify({ dependencies: { express: "^4.19.0" } }));
  const hash3 = computeDependencyHash(tmpDir);
  assert.notEqual(hash1, hash3);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("computeEnvHash detects env changes", () => {
  const env1 = { PORT: "3000", HOST: "0.0.0.0" };
  const env2 = { HOST: "0.0.0.0", PORT: "3000" }; // same, different key order
  assert.equal(computeEnvHash(env1), computeEnvHash(env2));

  const env3 = { PORT: "3001", HOST: "0.0.0.0" };
  assert.notEqual(computeEnvHash(env1), computeEnvHash(env3));
});

test("computeProjectId creates consistent normalized ID", () => {
  const id1 = computeProjectId("S:/mcp-builds/docker-env-server");
  const id2 = computeProjectId("S:\\mcp-builds\\docker-env-server");
  assert.equal(id1, id2);
  assert.equal(id1.length, 16);
});

test("parsePortMappings handles string and object formats", () => {
  const mappings = parsePortMappings([
    "3000:3000",
    "8080:80/tcp",
    "127.0.0.1:9000:9000",
    { hostPort: 5432, containerPort: 5432 },
  ]);

  assert.ok(mappings.ExposedPorts["3000/tcp"]);
  assert.ok(mappings.ExposedPorts["80/tcp"]);
  assert.ok(mappings.ExposedPorts["9000/tcp"]);
  assert.ok(mappings.ExposedPorts["5432/tcp"]);

  assert.equal(mappings.PortBindings["3000/tcp"][0].HostPort, "3000");
  assert.equal(mappings.PortBindings["80/tcp"][0].HostPort, "8080");
  assert.equal(mappings.PortBindings["9000/tcp"][0].HostIp, "127.0.0.1");
  assert.equal(mappings.PortBindings["5432/tcp"][0].HostPort, "5432");
});
