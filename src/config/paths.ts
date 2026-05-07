import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";

// Prefer env-var overrides so vi.stubEnv("HOME"/"USERPROFILE") works in tests,
// but validate with existsSync first. On Windows, tools like Git Bash set HOME
// to a Unix-style path (e.g. /c/Users/foo) that doesn't resolve on the Windows
// filesystem; os.homedir() handles that case correctly.
function getHomeDir(): string {
  const fromEnv = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  return os.homedir();
}

export { getHomeDir };

import { resolveWorktreeMainRepoRoot } from "../git/index.js";

const PROJECT_CONFIG_RELATIVE_PATH = path.join(".opencode", "codebase-index.json");
const PROJECT_INDEX_RELATIVE_PATH = path.join(".opencode", "index");

function resolveWorktreeFallbackPath(projectRoot: string, relativePath: string): string | null {
  const mainRepoRoot = resolveWorktreeMainRepoRoot(projectRoot);
  if (!mainRepoRoot) {
    return null;
  }

  const fallbackPath = path.join(mainRepoRoot, relativePath);
  return existsSync(fallbackPath) ? fallbackPath : null;
}

function hasProjectConfig(projectRoot: string): boolean {
  return existsSync(path.join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH));
}

export function getGlobalIndexPath(): string {
  return path.join(getHomeDir(), ".opencode", "global-index");
}

export function resolveProjectConfigPath(projectRoot: string): string {
  const localConfigPath = path.join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH);
  if (existsSync(localConfigPath)) {
    return localConfigPath;
  }

  return resolveWorktreeFallbackPath(projectRoot, PROJECT_CONFIG_RELATIVE_PATH) ?? localConfigPath;
}

export function resolveWritableProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH);
}

export function resolveProjectIndexPath(projectRoot: string, scope: "project" | "global"): string {
  if (scope === "global") {
    return getGlobalIndexPath();
  }

  const localIndexPath = path.join(projectRoot, PROJECT_INDEX_RELATIVE_PATH);
  if (existsSync(localIndexPath)) {
    return localIndexPath;
  }

  if (hasProjectConfig(projectRoot)) {
    return localIndexPath;
  }

  return resolveWorktreeFallbackPath(projectRoot, PROJECT_INDEX_RELATIVE_PATH) ?? localIndexPath;
}
