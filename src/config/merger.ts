import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { resolveProjectConfigPath } from "./paths.js";

function loadJsonFile(filePath: string): unknown {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    }
  } catch { /* ignore */ }
  return null;
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

      return path.normalize(path.relative(toDir, path.resolve(fromDir, trimmed)));
    })
    .filter(Boolean);
}

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  const relativePath = path.relative(rootDir, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
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
          return path.normalize(path.relative(sourceRoot, trimmed) || ".");
        }

        return path.normalize(trimmed);
      }

      const resolvedFromSource = path.resolve(sourceRoot, trimmed);
      if (isWithinRoot(sourceRoot, resolvedFromSource)) {
        return path.normalize(trimmed);
      }

      return path.normalize(path.relative(targetRoot, resolvedFromSource));
    })
    .filter(Boolean);
}

export function materializeLocalProjectConfig(projectRoot: string, config: unknown): string {
  const localConfigPath = path.join(projectRoot, ".opencode", "codebase-index.json");
  mkdirSync(path.dirname(localConfigPath), { recursive: true });
  writeFileSync(localConfigPath, JSON.stringify(config, null, 2), "utf-8");
  return localConfigPath;
}

export function loadProjectConfigLayer(projectRoot: string): Record<string, unknown> {
  const projectConfigPath = resolveProjectConfigPath(projectRoot);
  const projectConfig = loadJsonFile(projectConfigPath) as Record<string, unknown> | null;

  if (!projectConfig) {
    return {};
  }

  const normalizedConfig: Record<string, unknown> = { ...projectConfig };
  const projectConfigBaseDir = path.dirname(path.dirname(projectConfigPath));

  if (Array.isArray(normalizedConfig.knowledgeBases)) {
    normalizedConfig.knowledgeBases = resolveInheritedKnowledgeBaseEntries(
      normalizedConfig.knowledgeBases,
      projectConfigBaseDir,
      projectRoot,
    );
  }

  return normalizedConfig;
}

/**
 * Loads and merges global and project configs.
 * 
 * Merge rules:
 * - Global config is the base
 * - For most fields: project overrides global if set, otherwise load global (fallback)
 * - For knowledgeBases: merge arrays (union, deduplicated)
 * - For additionalInclude: merge arrays (union, deduplicated)
 * - For include/exclude: project overrides global if set, otherwise load global
 */
export function loadMergedConfig(projectRoot: string): unknown {
  const globalConfigPath = os.homedir() + "/.config/opencode/codebase-index.json";
  const globalConfig = loadJsonFile(globalConfigPath) as Record<string, unknown> | null;
  const projectConfigPath = resolveProjectConfigPath(projectRoot);
  const projectConfig = loadJsonFile(projectConfigPath) as Record<string, unknown> | null;
  const normalizedProjectConfig = loadProjectConfigLayer(projectRoot);

  // If neither exists, return empty
  if (!globalConfig && !projectConfig) {
    return {};
  }

  // If only global exists, return it
  if (!projectConfig && globalConfig) {
    return globalConfig;
  }

  // If only project exists, return it
  if (!globalConfig && projectConfig) {
    return normalizedProjectConfig;
  }

  // Both exist - start with global config as base
  const merged: Record<string, unknown> = { ...globalConfig };

  // For embeddingProvider: project overrides if set, otherwise use global
  if (projectConfig && "embeddingProvider" in normalizedProjectConfig) {
    merged.embeddingProvider = normalizedProjectConfig.embeddingProvider;
  } else if (globalConfig && globalConfig.embeddingProvider) {
    merged.embeddingProvider = globalConfig.embeddingProvider;
  }

  // For customProvider: project overrides if set, otherwise use global
  if (projectConfig && "customProvider" in normalizedProjectConfig) {
    merged.customProvider = normalizedProjectConfig.customProvider;
  } else if (globalConfig && globalConfig.customProvider) {
    merged.customProvider = globalConfig.customProvider;
  }

  // For embeddingModel: project overrides if set, otherwise use global
  if (projectConfig && "embeddingModel" in normalizedProjectConfig) {
    merged.embeddingModel = normalizedProjectConfig.embeddingModel;
  } else if (globalConfig && globalConfig.embeddingModel) {
    merged.embeddingModel = globalConfig.embeddingModel;
  }

  // For reranker: project overrides if set, otherwise use global
  if (projectConfig && "reranker" in normalizedProjectConfig) {
    merged.reranker = normalizedProjectConfig.reranker;
  } else if (globalConfig && globalConfig.reranker) {
    merged.reranker = globalConfig.reranker;
  }

  // For include: project overrides if set, otherwise use global
  if (projectConfig && "include" in normalizedProjectConfig) {
    merged.include = normalizedProjectConfig.include;
  } else if (globalConfig && globalConfig.include) {
    merged.include = globalConfig.include;
  }

  // For exclude: project overrides if set, otherwise use global
  if (projectConfig && "exclude" in normalizedProjectConfig) {
    merged.exclude = normalizedProjectConfig.exclude;
  } else if (globalConfig && globalConfig.exclude) {
    merged.exclude = globalConfig.exclude;
  }

  // For indexing: project overrides if set, otherwise use global
  if (projectConfig && "indexing" in normalizedProjectConfig) {
    merged.indexing = normalizedProjectConfig.indexing;
  } else if (globalConfig && globalConfig.indexing) {
    merged.indexing = globalConfig.indexing;
  }

  // For search: project overrides if set, otherwise use global
  if (projectConfig && "search" in normalizedProjectConfig) {
    merged.search = normalizedProjectConfig.search;
  } else if (globalConfig && globalConfig.search) {
    merged.search = globalConfig.search;
  }

  // For debug: project overrides if set, otherwise use global
  if (projectConfig && "debug" in normalizedProjectConfig) {
    merged.debug = normalizedProjectConfig.debug;
  } else if (globalConfig && globalConfig.debug) {
    merged.debug = globalConfig.debug;
  }

  // For scope: project overrides if set, otherwise use global
  if (projectConfig && "scope" in normalizedProjectConfig) {
    merged.scope = normalizedProjectConfig.scope;
  } else if (globalConfig && "scope" in globalConfig) {
    merged.scope = globalConfig.scope;
  }

  // For other config sections: project overrides if set, otherwise use global
  if (projectConfig) {
    for (const key of Object.keys(projectConfig)) {
      if (
        key === "embeddingProvider" ||
        key === "customProvider" ||
        key === "embeddingModel" ||
        key === "reranker" ||
        key === "include" ||
        key === "exclude" ||
        key === "indexing" ||
        key === "search" ||
        key === "debug" ||
        key === "scope" ||
        key === "knowledgeBases" ||
        key === "additionalInclude"
      ) {
        continue; // Already handled above
      }
      merged[key] = normalizedProjectConfig[key];
    }
  }

  // For knowledgeBases: merge arrays (union, deduplicated)
  const globalKbs = globalConfig && Array.isArray(globalConfig.knowledgeBases) ? globalConfig.knowledgeBases : [];
  const projectKbs = projectConfig
    ? (Array.isArray(normalizedProjectConfig.knowledgeBases) ? normalizedProjectConfig.knowledgeBases as string[] : [])
    : [];
  const allKbs = [...globalKbs, ...projectKbs];
  const uniqueKbs = [...new Set(allKbs.map(p => String(p).trim()))];
  merged.knowledgeBases = uniqueKbs;

  // For additionalInclude: merge arrays (union, deduplicated)
  const globalAdditional = globalConfig && Array.isArray(globalConfig.additionalInclude) ? globalConfig.additionalInclude : [];
  const projectAdditional = projectConfig && Array.isArray(projectConfig.additionalInclude) ? projectConfig.additionalInclude : [];
  const allAdditional = [...globalAdditional, ...projectAdditional];
  const uniqueAdditional = [...new Set(allAdditional.map(p => String(p).trim()))];
  merged.additionalInclude = uniqueAdditional;

  return merged;
}
