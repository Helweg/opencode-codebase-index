import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import * as path from "path";
import { execSync } from "child_process";

export function isGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

export function getCurrentBranch(repoRoot: string): string | null {
  const headPath = path.join(repoRoot, ".git", "HEAD");
  
  if (!existsSync(headPath)) {
    return null;
  }

  try {
    const headContent = readFileSync(headPath, "utf-8").trim();
    
    // Check if it's a symbolic reference (normal branch)
    const match = headContent.match(/^ref: refs\/heads\/(.+)$/);
    if (match) {
      return match[1];
    }

    // Detached HEAD - return short commit hash
    if (/^[0-9a-f]{40}$/i.test(headContent)) {
      return headContent.slice(0, 7);
    }

    return null;
  } catch {
    return null;
  }
}

export function getCurrentCommit(repoRoot: string): string | null {
  try {
    const result = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

export function getBaseBranch(repoRoot: string): string {
  // Try to detect the default branch
  const candidates = ["main", "master", "develop", "trunk"];
  
  for (const candidate of candidates) {
    const refPath = path.join(repoRoot, ".git", "refs", "heads", candidate);
    if (existsSync(refPath)) {
      return candidate;
    }
    
    // Also check packed-refs
    const packedRefsPath = path.join(repoRoot, ".git", "packed-refs");
    if (existsSync(packedRefsPath)) {
      try {
        const content = readFileSync(packedRefsPath, "utf-8");
        if (content.includes(`refs/heads/${candidate}`)) {
          return candidate;
        }
      } catch {
        // Ignore
      }
    }
  }

  // Try git remote show origin
  try {
    const result = execSync("git remote show origin", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = result.match(/HEAD branch: (.+)/);
    if (match) {
      return match[1].trim();
    }
  } catch {
    // Ignore - remote might not exist
  }

  // Fallback to current branch or "main"
  return getCurrentBranch(repoRoot) ?? "main";
}

export function getAllBranches(repoRoot: string): string[] {
  const branches: string[] = [];
  const refsPath = path.join(repoRoot, ".git", "refs", "heads");
  
  if (!existsSync(refsPath)) {
    return branches;
  }

  try {
    const result = execSync("git branch --list", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    
    for (const line of result.split("\n")) {
      const branch = line.replace(/^\*?\s+/, "").trim();
      if (branch) {
        branches.push(branch);
      }
    }
  } catch {
    // Fallback: read refs directory
    try {
      const entries = readdirSync(refsPath);
      for (const entry of entries) {
        const stat = statSync(path.join(refsPath, entry));
        if (stat.isFile()) {
          branches.push(entry);
        }
      }
    } catch {
      // Ignore
    }
  }

  return branches;
}

export function getChangedFiles(
  repoRoot: string,
  fromCommit: string,
  toCommit: string = "HEAD"
): string[] {
  try {
    const result = execSync(`git diff --name-only ${fromCommit} ${toCommit}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    
    return result
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export function getBranchOrDefault(repoRoot: string): string {
  if (!isGitRepo(repoRoot)) {
    return "default";
  }
  
  return getCurrentBranch(repoRoot) ?? "default";
}

export function getHeadPath(repoRoot: string): string {
  return path.join(repoRoot, ".git", "HEAD");
}
