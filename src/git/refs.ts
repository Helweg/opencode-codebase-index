import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import * as path from "path";

export function readPackedRefs(gitDir: string): string[] {
  const packedRefsPath = path.join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) {
    return [];
  }

  try {
    return readFileSync(packedRefsPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("^"));
  } catch {
    return [];
  }
}

export function resolveCommonGitDir(gitDir: string): string {
  const commonDirPath = path.join(gitDir, "commondir");
  if (!existsSync(commonDirPath)) {
    return gitDir;
  }

  try {
    const raw = readFileSync(commonDirPath, "utf-8").trim();
    if (!raw) {
      return gitDir;
    }

    const resolved = path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
    if (existsSync(resolved)) {
      return resolved;
    }
  } catch {
    return gitDir;
  }

  return gitDir;
}

export function tryResolveRefCommit(gitDir: string, refPath: string): string | null {
  const looseRefPath = path.join(gitDir, refPath);
  if (existsSync(looseRefPath)) {
    try {
      const value = readFileSync(looseRefPath, "utf-8").trim();
      if (/^[0-9a-f]{40}$/i.test(value)) {
        return value;
      }
    } catch {
      return null;
    }
  }

  const packedRefs = readPackedRefs(gitDir);
  for (const line of packedRefs) {
    const splitIndex = line.indexOf(" ");
    if (splitIndex <= 0) {
      continue;
    }

    const commit = line.slice(0, splitIndex).trim();
    const packedRef = line.slice(splitIndex + 1).trim();
    if (packedRef === refPath && /^[0-9a-f]{40}$/i.test(commit)) {
      return commit;
    }
  }

  return null;
}

export function collectBranchRefs(branches: string[], baseDir: string, prefix = ""): void {
  if (!existsSync(baseDir)) {
    return;
  }

  try {
    const entries = readdirSync(baseDir);
    for (const entry of entries) {
      const nextPath = path.join(baseDir, entry);
      const nextPrefix = prefix ? `${prefix}/${entry}` : entry;
      const stat = statSync(nextPath);
      if (stat.isDirectory()) {
        collectBranchRefs(branches, nextPath, nextPrefix);
      } else if (stat.isFile()) {
        branches.push(nextPrefix);
      }
    }
  } catch {
    return;
  }
}
