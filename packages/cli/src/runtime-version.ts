import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJsonShape {
  name?: string;
  version?: string;
}

function readRootPackageVersion(filePath: string): string | null {
  try {
    const packageJson = JSON.parse(readFileSync(filePath, "utf8")) as PackageJsonShape;
    if (packageJson.name !== "bb-browser") return null;
    if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") return null;
    return packageJson.version.trim();
  } catch {
    return null;
  }
}

export function getRuntimePackageVersion(moduleUrl: string, fallbackVersion: string): string {
  let currentDir = dirname(fileURLToPath(moduleUrl));

  for (let depth = 0; depth < 6; depth += 1) {
    const version = readRootPackageVersion(resolve(currentDir, "package.json"));
    if (version) return version;

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return fallbackVersion;
}
