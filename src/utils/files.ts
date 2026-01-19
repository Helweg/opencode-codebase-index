import ignore, { Ignore } from "ignore";
import { existsSync, readFileSync, promises as fsPromises } from "fs";
import * as path from "path";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "CMakeLists.txt",
  "Makefile",
  ".opencode",
];

export function hasProjectMarker(projectRoot: string): boolean {
  for (const marker of PROJECT_MARKERS) {
    if (existsSync(path.join(projectRoot, marker))) {
      return true;
    }
  }
  return false;
}

export interface SkippedFile {
  path: string;
  reason: "too_large" | "excluded" | "gitignore" | "no_match";
}

export interface CollectFilesResult {
  files: Array<{ path: string; size: number }>;
  skipped: SkippedFile[];
}

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
    ".opencode",
  ];

  ig.add(defaultIgnores);

  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignoreContent = readFileSync(gitignorePath, "utf-8");
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
  let regexPattern = pattern
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\{([^}]+)\}/g, (_, p1) => `(${p1.split(",").join("|")})`);

  // **/*.js → matches both root "file.js" and nested "dir/file.js"
  if (regexPattern.startsWith(".*/")) {
    regexPattern = `(.*\\/)?${regexPattern.slice(3)}`;
  }

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}

export async function* walkDirectory(
  dir: string,
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  ignoreFilter: Ignore,
  maxFileSize: number,
  skipped: SkippedFile[]
): AsyncGenerator<{ path: string; size: number }> {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(projectRoot, fullPath);

    if (ignoreFilter.ignores(relativePath)) {
      if (entry.isFile()) {
        skipped.push({ path: relativePath, reason: "gitignore" });
      }
      continue;
    }

    if (entry.isDirectory()) {
      yield* walkDirectory(
        fullPath,
        projectRoot,
        includePatterns,
        excludePatterns,
        ignoreFilter,
        maxFileSize,
        skipped
      );
    } else if (entry.isFile()) {
      const stat = await fsPromises.stat(fullPath);

      if (stat.size > maxFileSize) {
        skipped.push({ path: relativePath, reason: "too_large" });
        continue;
      }

      for (const pattern of excludePatterns) {
        if (matchGlob(relativePath, pattern)) {
          skipped.push({ path: relativePath, reason: "excluded" });
          continue;
        }
      }

      let matched = false;
      for (const pattern of includePatterns) {
        if (matchGlob(relativePath, pattern)) {
          matched = true;
          break;
        }
      }

      if (matched) {
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
): Promise<CollectFilesResult> {
  const ignoreFilter = createIgnoreFilter(projectRoot);
  const files: Array<{ path: string; size: number }> = [];
  const skipped: SkippedFile[] = [];

  for await (const file of walkDirectory(
    projectRoot,
    projectRoot,
    includePatterns,
    excludePatterns,
    ignoreFilter,
    maxFileSize,
    skipped
  )) {
    files.push(file);
  }

  return { files, skipped };
}
