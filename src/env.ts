import fs from "node:fs";
import path from "node:path";

/**
 * Parses the contents of a .env file into key-value pairs.
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comment lines
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Strip optional "export " prefix
    const lineWithoutExport = trimmed.startsWith("export ")
      ? trimmed.substring(7).trim()
      : trimmed;

    const equalIndex = lineWithoutExport.indexOf("=");
    if (equalIndex === -1) {
      continue;
    }

    const key = lineWithoutExport.substring(0, equalIndex).trim();
    let value = lineWithoutExport.substring(equalIndex + 1).trim();

    // Strip matching wrapping quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.substring(1, value.length - 1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Loads and merges environment variables from a list of env files (relative or absolute)
 * and an optional dictionary of extra env variables.
 */
export function loadEnvFilesAndVars(
  basePath: string,
  envFilePaths: string[] = [],
  extraVars: Record<string, string> = {}
): { envRecord: Record<string, string>; envArray: string[] } {
  const merged: Record<string, string> = {};

  for (const rawFilePath of envFilePaths) {
    // Check path relative to basePath first, then relative to process.cwd()
    let resolved = path.isAbsolute(rawFilePath)
      ? rawFilePath
      : path.resolve(basePath, rawFilePath);

    if (!fs.existsSync(resolved)) {
      const fallback = path.resolve(process.cwd(), rawFilePath);
      if (fs.existsSync(fallback)) {
        resolved = fallback;
      }
    }

    if (fs.existsSync(resolved)) {
      try {
        const content = fs.readFileSync(resolved, "utf-8");
        const parsed = parseEnvContent(content);
        Object.assign(merged, parsed);
      } catch (err) {
        console.warn(`Warning: Could not read env file at ${resolved}:`, err);
      }
    } else {
      console.warn(`Warning: Env file not found: ${rawFilePath} (resolved: ${resolved})`);
    }
  }

  // Merge extra vars (highest precedence)
  Object.assign(merged, extraVars);

  const envArray = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  return { envRecord: merged, envArray };
}
