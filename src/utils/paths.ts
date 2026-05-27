import * as path from "path";

export function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

export function isHiddenPathSegment(part: string): boolean {
  return part.startsWith(".") && part !== "." && part !== "..";
}

export function isBuildPathSegment(part: string): boolean {
  return part.toLowerCase().includes("build");
}

export function hasFilteredPathSegment(relativePath: string, separator: string = path.sep): boolean {
  return relativePath.split(separator).some(
    (part) => isHiddenPathSegment(part) || isBuildPathSegment(part)
  );
}
