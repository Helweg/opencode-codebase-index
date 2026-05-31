import * as path from "path";

import { normalizePathSeparators } from "../utils/paths.js";

export function resolveConfigPathValue(value: string, baseDir: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
  return path.normalize(absolutePath);
}

export function serializeConfigPathValue(value: string, baseDir: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (!path.isAbsolute(trimmed)) {
    return normalizePathSeparators(path.normalize(trimmed));
  }

  const relativePath = path.relative(baseDir, trimmed);
  if (!relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return normalizePathSeparators(path.normalize(relativePath || "."));
  }

  return path.normalize(trimmed);
}

export function resolveKnowledgeBasePath(value: string, projectRoot: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export function normalizeKnowledgeBasePath(value: string, projectRoot: string): string {
  return path.normalize(resolveKnowledgeBasePath(value, projectRoot));
}

export function hasMatchingKnowledgeBasePath(
  knowledgeBases: string[],
  inputPath: string,
  projectRoot: string,
): boolean {
  const normalizedInput = path.normalize(inputPath);
  return knowledgeBases.some((kb) => normalizeKnowledgeBasePath(kb, projectRoot) === normalizedInput);
}

export function findKnowledgeBasePathIndex(
  knowledgeBases: string[],
  inputPath: string,
  projectRoot: string,
): number {
  const normalizedInput = path.normalize(inputPath);
  return knowledgeBases.findIndex(
    (kb) => path.normalize(kb) === normalizedInput || normalizeKnowledgeBasePath(kb, projectRoot) === normalizedInput
  );
}
