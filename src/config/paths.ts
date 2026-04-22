import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";

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

export function getGlobalIndexPath(): string {
  return path.join(os.homedir(), ".opencode", "global-index");
}

export function resolveProjectConfigPath(projectRoot: string): string {
  const localConfigPath = path.join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH);
  if (existsSync(localConfigPath)) {
    return localConfigPath;
  }

  return resolveWorktreeFallbackPath(projectRoot, PROJECT_CONFIG_RELATIVE_PATH) ?? localConfigPath;
}

export function resolveProjectIndexPath(projectRoot: string, scope: "project" | "global"): string {
  if (scope === "global") {
    return getGlobalIndexPath();
  }

  const localIndexPath = path.join(projectRoot, PROJECT_INDEX_RELATIVE_PATH);
  if (existsSync(localIndexPath)) {
    return localIndexPath;
  }

  return resolveWorktreeFallbackPath(projectRoot, PROJECT_INDEX_RELATIVE_PATH) ?? localIndexPath;
}
