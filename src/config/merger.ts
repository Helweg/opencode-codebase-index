import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";

function loadJsonFile(filePath: string): unknown {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    }
  } catch { /* ignore */ }
  return null;
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
  const globalConfigPath = path.join(os.homedir(), ".config", "opencode", "codebase-index.json");
  const globalConfig = loadJsonFile(globalConfigPath) as Record<string, unknown> | null;
  const projectConfigPath = path.join(projectRoot, ".opencode", "codebase-index.json");
  const projectConfig = loadJsonFile(projectConfigPath) as Record<string, unknown> | null;

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
    return projectConfig;
  }

  // Both exist - start with global config as base
  const merged: Record<string, unknown> = { ...globalConfig };

  // For embeddingProvider: project overrides if set, otherwise use global
  if (projectConfig && "embeddingProvider" in projectConfig) {
    merged.embeddingProvider = projectConfig.embeddingProvider;
  } else if (globalConfig && globalConfig.embeddingProvider) {
    merged.embeddingProvider = globalConfig.embeddingProvider;
  }

  // For customProvider: project overrides if set, otherwise use global
  if (projectConfig && "customProvider" in projectConfig) {
    merged.customProvider = projectConfig.customProvider;
  } else if (globalConfig && globalConfig.customProvider) {
    merged.customProvider = globalConfig.customProvider;
  }

  // For embeddingModel: project overrides if set, otherwise use global
  if (projectConfig && "embeddingModel" in projectConfig) {
    merged.embeddingModel = projectConfig.embeddingModel;
  } else if (globalConfig && globalConfig.embeddingModel) {
    merged.embeddingModel = globalConfig.embeddingModel;
  }

  // For reranker: project overrides if set, otherwise use global
  if (projectConfig && "reranker" in projectConfig) {
    merged.reranker = projectConfig.reranker;
  } else if (globalConfig && globalConfig.reranker) {
    merged.reranker = globalConfig.reranker;
  }

  // For include: project overrides if set, otherwise use global
  if (projectConfig && "include" in projectConfig) {
    merged.include = projectConfig.include;
  } else if (globalConfig && globalConfig.include) {
    merged.include = globalConfig.include;
  }

  // For exclude: project overrides if set, otherwise use global
  if (projectConfig && "exclude" in projectConfig) {
    merged.exclude = projectConfig.exclude;
  } else if (globalConfig && globalConfig.exclude) {
    merged.exclude = globalConfig.exclude;
  }

  // For indexing: project overrides if set, otherwise use global
  if (projectConfig && "indexing" in projectConfig) {
    merged.indexing = projectConfig.indexing;
  } else if (globalConfig && globalConfig.indexing) {
    merged.indexing = globalConfig.indexing;
  }

  // For search: project overrides if set, otherwise use global
  if (projectConfig && "search" in projectConfig) {
    merged.search = projectConfig.search;
  } else if (globalConfig && globalConfig.search) {
    merged.search = globalConfig.search;
  }

  // For debug: project overrides if set, otherwise use global
  if (projectConfig && "debug" in projectConfig) {
    merged.debug = projectConfig.debug;
  } else if (globalConfig && globalConfig.debug) {
    merged.debug = globalConfig.debug;
  }

  // For scope: project overrides if set, otherwise use global
  if (projectConfig && "scope" in projectConfig) {
    merged.scope = projectConfig.scope;
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
      merged[key] = projectConfig[key];
    }
  }

  // For knowledgeBases: merge arrays (union, deduplicated)
  const globalKbs = globalConfig && Array.isArray(globalConfig.knowledgeBases) ? globalConfig.knowledgeBases : [];
  const projectKbs = projectConfig && Array.isArray(projectConfig.knowledgeBases) ? projectConfig.knowledgeBases : [];
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
