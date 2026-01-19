import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import * as path from "path";
import { execSync } from "child_process";

/**
 * Resolves the actual git directory path.
 * 
 * In a normal repo, `.git` is a directory containing HEAD, refs, etc.
 * In a worktree, `.git` is a file containing `gitdir: /path/to/actual/git/dir`.
 * 
 * @returns The resolved git directory path, or null if not a git repo
 */
export function resolveGitDir(repoRoot: string): string | null {
  const gitPath = path.join(repoRoot, ".git");
  
  if (!existsSync(gitPath)) {
    return null;
  }
  
  try {
    const stat = statSync(gitPath);
    
    if (stat.isDirectory()) {
      // Normal repo: .git is a directory
      return gitPath;
    }
    
    if (stat.isFile()) {
      // Worktree: .git is a file with gitdir pointer
      const content = readFileSync(gitPath, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        const gitdir = match[1];
        // Handle relative paths
        const resolvedPath = path.isAbsolute(gitdir)
          ? gitdir
          : path.resolve(repoRoot, gitdir);
        
        if (existsSync(resolvedPath)) {
          return resolvedPath;
        }
      }
    }
  } catch {
    // Ignore errors (permission issues, etc.)
  }
  
  return null;
}

export function isGitRepo(dir: string): boolean {
  return resolveGitDir(dir) !== null;
}

export function getCurrentBranch(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) {
    return null;
  }
  
  const headPath = path.join(gitDir, "HEAD");
  
  if (!existsSync(headPath)) {
    return null;
  }

  try {
    const headContent = readFileSync(headPath, "utf-8").trim();
    
    const match = headContent.match(/^ref: refs\/heads\/(.+)$/);
    if (match) {
      return match[1];
    }

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
  const gitDir = resolveGitDir(repoRoot);
  const candidates = ["main", "master", "develop", "trunk"];
  
  if (gitDir) {
    for (const candidate of candidates) {
      const refPath = path.join(gitDir, "refs", "heads", candidate);
      if (existsSync(refPath)) {
        return candidate;
      }
      
      const packedRefsPath = path.join(gitDir, "packed-refs");
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
  }

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

  return getCurrentBranch(repoRoot) ?? "main";
}

export function getAllBranches(repoRoot: string): string[] {
  const branches: string[] = [];
  const gitDir = resolveGitDir(repoRoot);
  
  if (!gitDir) {
    return branches;
  }
  
  const refsPath = path.join(gitDir, "refs", "heads");
  
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
  const gitDir = resolveGitDir(repoRoot);
  if (gitDir) {
    return path.join(gitDir, "HEAD");
  }
  return path.join(repoRoot, ".git", "HEAD");
}
