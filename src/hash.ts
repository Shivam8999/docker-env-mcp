import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Manifest files indicating dependencies for various ecosystems.
 */
export const DEPENDENCY_FILES = [
  // Node.js / JavaScript / TypeScript
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  // Python
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "pyproject.toml",
  "poetry.lock",
  // Rust
  "Cargo.toml",
  "Cargo.lock",
  // Go
  "go.mod",
  "go.sum",
  // Ruby
  "Gemfile",
  "Gemfile.lock",
  // PHP
  "composer.json",
  "composer.lock",
  // Java / JVM
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

/**
 * Calculates a SHA-256 hash of all dependency manifest files in a directory.
 */
export function computeDependencyHash(folderPath: string): string {
  const hash = crypto.createHash("sha256");
  let foundAny = false;

  for (const depFile of DEPENDENCY_FILES) {
    const fullPath = path.join(folderPath, depFile);
    if (fs.existsSync(fullPath)) {
      try {
        const stats = fs.statSync(fullPath);
        if (stats.isFile()) {
          foundAny = true;
          const content = fs.readFileSync(fullPath);
          hash.update(`${depFile}:`);
          hash.update(content);
          hash.update("\n");
        }
      } catch (err) {
        console.warn(`Warning: Could not read dependency file ${fullPath}:`, err);
      }
    }
  }

  // If no standard dependency manifests found, return a sentinel hash
  if (!foundAny) {
    return "no-deps";
  }

  return hash.digest("hex");
}

/**
 * Calculates a SHA-256 hash of environment variables.
 */
export function computeEnvHash(envRecord: Record<string, string>): string {
  const keys = Object.keys(envRecord).sort();
  if (keys.length === 0) {
    return "no-env";
  }

  const hash = crypto.createHash("sha256");
  for (const key of keys) {
    hash.update(`${key}=${envRecord[key]}\n`);
  }

  return hash.digest("hex");
}

/**
 * Generates a stable project ID (16 hex chars) based on the absolute folder path.
 */
export function computeProjectId(folderPath: string): string {
  const normalized = path.resolve(folderPath).toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex").substring(0, 16);
}
