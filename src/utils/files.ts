import ignore, { Ignore } from "ignore";
import * as fs from "fs";
import * as path from "path";

export function createIgnoreFilter(projectRoot: string): Ignore {
  const ig = ignore();

  const defaultIgnores = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    "__pycache__",
    "target",
    "vendor",
    ".opencode/index",
  ];

  ig.add(defaultIgnores);

  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  }

  return ig;
}

export function shouldIncludeFile(
  filePath: string,
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  ignoreFilter: Ignore
): boolean {
  const relativePath = path.relative(projectRoot, filePath);

  if (ignoreFilter.ignores(relativePath)) {
    return false;
  }

  for (const pattern of excludePatterns) {
    if (matchGlob(relativePath, pattern)) {
      return false;
    }
  }

  for (const pattern of includePatterns) {
    if (matchGlob(relativePath, pattern)) {
      return true;
    }
  }

  return false;
}

function matchGlob(filePath: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\{([^}]+)\}/g, (_, p1) => `(${p1.split(",").join("|")})`);

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}

export async function* walkDirectory(
  dir: string,
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  ignoreFilter: Ignore,
  maxFileSize: number
): AsyncGenerator<{ path: string; size: number }> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(projectRoot, fullPath);

    if (ignoreFilter.ignores(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      yield* walkDirectory(
        fullPath,
        projectRoot,
        includePatterns,
        excludePatterns,
        ignoreFilter,
        maxFileSize
      );
    } else if (entry.isFile()) {
      const stat = await fs.promises.stat(fullPath);

      if (stat.size > maxFileSize) {
        continue;
      }

      if (
        shouldIncludeFile(
          fullPath,
          projectRoot,
          includePatterns,
          excludePatterns,
          ignoreFilter
        )
      ) {
        yield { path: fullPath, size: stat.size };
      }
    }
  }
}

export async function collectFiles(
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  maxFileSize: number
): Promise<Array<{ path: string; size: number }>> {
  const ignoreFilter = createIgnoreFilter(projectRoot);
  const files: Array<{ path: string; size: number }> = [];

  for await (const file of walkDirectory(
    projectRoot,
    projectRoot,
    includePatterns,
    excludePatterns,
    ignoreFilter,
    maxFileSize
  )) {
    files.push(file);
  }

  return files;
}
