import * as path from "path";

import { normalizePathSeparators } from "../utils/paths.js";


function isWithinRoot(rootDir: string, targetPath: string): boolean {
  const relativePath = path.relative(rootDir, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function rebasePathEntries(
  values: unknown,
  fromDir: string,
  toDir: string,
): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => {
      const trimmed = value.trim();
      if (!trimmed || path.isAbsolute(trimmed)) {
        return trimmed;
      }

      return normalizePathSeparators(path.normalize(path.relative(toDir, path.resolve(fromDir, trimmed))));
    })
    .filter(Boolean);
}

export function resolveInheritedKnowledgeBaseEntries(
  values: unknown,
  sourceRoot: string,
  targetRoot: string,
): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return trimmed;
      }

      if (path.isAbsolute(trimmed)) {
        if (isWithinRoot(sourceRoot, trimmed)) {
          return normalizePathSeparators(path.normalize(path.relative(sourceRoot, trimmed) || "."));
        }

        return path.normalize(trimmed);
      }

      const resolvedFromSource = path.resolve(sourceRoot, trimmed);
      if (isWithinRoot(sourceRoot, resolvedFromSource)) {
        return normalizePathSeparators(path.normalize(trimmed));
      }

      return normalizePathSeparators(path.normalize(path.relative(targetRoot, resolvedFromSource)));
    })
    .filter(Boolean);
}
