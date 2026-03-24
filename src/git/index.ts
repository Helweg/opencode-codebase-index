import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import * as path from "path";

function readPackedRefs(gitDir: string): string[] {
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

function resolveCommonGitDir(gitDir: string): string {
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

function tryResolveRefCommit(gitDir: string, refPath: string): string | null {
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
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) {
    return null;
  }
  const refStoreDir = resolveCommonGitDir(gitDir);

  const headPath = path.join(gitDir, "HEAD");
  if (!existsSync(headPath)) {
    return null;
  }

  try {
    const headContent = readFileSync(headPath, "utf-8").trim();

    if (/^[0-9a-f]{40}$/i.test(headContent)) {
      return headContent;
    }

    const refMatch = headContent.match(/^ref:\s*(.+)$/);
    if (!refMatch) {
      return null;
    }

    return tryResolveRefCommit(refStoreDir, refMatch[1]);
  } catch {
    return null;
  }
}

export function getBaseBranch(repoRoot: string): string {
  const gitDir = resolveGitDir(repoRoot);
  const refStoreDir = gitDir ? resolveCommonGitDir(gitDir) : null;
  const candidates = ["main", "master", "develop", "trunk"];
  
  if (refStoreDir) {
    for (const candidate of candidates) {
      const refPath = path.join(refStoreDir, "refs", "heads", candidate);
      if (existsSync(refPath)) {
        return candidate;
      }

      const packedRefs = readPackedRefs(refStoreDir);
      if (packedRefs.some((line) => line.endsWith(` refs/heads/${candidate}`))) {
        return candidate;
      }
    }
  }

  return getCurrentBranch(repoRoot) ?? "main";
}

function collectBranchRefs(branches: string[], baseDir: string, prefix = ""): void {
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

export function getAllBranches(repoRoot: string): string[] {
  const branchSet = new Set<string>();
  const gitDir = resolveGitDir(repoRoot);
  const refStoreDir = gitDir ? resolveCommonGitDir(gitDir) : null;
  
  if (!refStoreDir) {
    return [];
  }
  
  const refsPath = path.join(refStoreDir, "refs", "heads");
  
  if (!existsSync(refsPath)) {
    return [];
  }

  const looseBranches: string[] = [];
  collectBranchRefs(looseBranches, refsPath);
  for (const branch of looseBranches) {
    branchSet.add(branch);
  }

  const packedRefs = readPackedRefs(refStoreDir);
  for (const line of packedRefs) {
    const splitIndex = line.indexOf(" ");
    if (splitIndex <= 0) {
      continue;
    }

    const ref = line.slice(splitIndex + 1).trim();
    const prefix = "refs/heads/";
    if (ref.startsWith(prefix)) {
      branchSet.add(ref.slice(prefix.length));
    }
  }

  return Array.from(branchSet).sort();
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
