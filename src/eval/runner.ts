import { existsSync } from "fs";
import { mkdirSync } from "fs";
import { readFileSync } from "fs";
import { rmSync } from "fs";
import { writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";

import { rebasePathEntries, resolveInheritedKnowledgeBaseEntries } from "../config/merger.js";
import { parseConfig } from "../config/schema.js";
import type { SearchConfig as ConfigSearchConfig } from "../config/schema.js";
import { getDefaultModelForProvider } from "../config/index.js";
import { getGlobalIndexPath, resolveProjectConfigPath, resolveProjectIndexPath } from "../config/paths.js";
import { Indexer } from "../indexer/index.js";

import { evaluateBudgetGate } from "./budget.js";
import { compareSummaries } from "./compare.js";
import { buildPerQueryResult, computeEvalMetrics } from "./metrics.js";
import {
  createSummaryMarkdown,
  createRunDirectory,
  loadSummary,
  writeJson,
  writeText,
  buildPerQueryArtifact,
} from "./reports.js";
import { loadBudget, loadGoldenDataset } from "./schema.js";
import type {
  EvalComparison,
  EvalGateResult,
  EvalRunOptions,
  EvalSummary,
  PerQueryEvalResult,
  SweepAggregateReport,
  SweepDefinition,
  SweepRunSummary,
} from "./types.js";

function toAbsolute(projectRoot: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(projectRoot, maybeRelative);
}

function isProjectScopedConfigPath(configPath: string): boolean {
  return path.basename(configPath) === "codebase-index.json"
    && path.basename(path.dirname(configPath)) === ".opencode";
}

function normalizeEvalConfigKnowledgeBases(
  rawConfig: unknown,
  projectRoot: string,
  resolvedConfigPath: string,
): Record<string, unknown> {
  const config = rawConfig && typeof rawConfig === "object"
    ? { ...(rawConfig as Record<string, unknown>) }
    : {};

  if (!Array.isArray(config.knowledgeBases)) {
    return config;
  }

  config.knowledgeBases = isProjectScopedConfigPath(resolvedConfigPath)
    ? resolveInheritedKnowledgeBaseEntries(
        config.knowledgeBases,
        path.dirname(path.dirname(resolvedConfigPath)),
        projectRoot,
      )
    : rebasePathEntries(
        config.knowledgeBases,
        path.dirname(resolvedConfigPath),
        projectRoot,
      );

  return config;
}

function loadRawConfig(projectRoot: string, configPath?: string): unknown {
  const fromPath = configPath ? toAbsolute(projectRoot, configPath) : null;
  if (fromPath && existsSync(fromPath)) {
    return normalizeEvalConfigKnowledgeBases(
      JSON.parse(readFileSync(fromPath, "utf-8")),
      projectRoot,
      fromPath,
    );
  }

  const projectConfig = resolveProjectConfigPath(projectRoot);
  if (existsSync(projectConfig)) {
    return normalizeEvalConfigKnowledgeBases(
      JSON.parse(readFileSync(projectConfig, "utf-8")),
      projectRoot,
      projectConfig,
    );
  }

  const globalConfig = path.join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir(), ".config", "opencode", "codebase-index.json");
  if (existsSync(globalConfig)) {
    return JSON.parse(readFileSync(globalConfig, "utf-8"));
  }

  return {};
}

function getIndexRootPath(projectRoot: string, scope: "project" | "global"): string {
  return scope === "global"
    ? getGlobalIndexPath()
    : resolveProjectIndexPath(projectRoot, scope);
}

function getLocalProjectIndexRoot(projectRoot: string): string {
  return path.join(projectRoot, ".opencode", "index");
}

function getLocalProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".opencode", "codebase-index.json");
}

function clearIndexRoot(projectRoot: string, scope: "project" | "global"): void {
  const indexRoot = scope === "global"
    ? getIndexRootPath(projectRoot, scope)
    : getLocalProjectIndexRoot(projectRoot);
  if (existsSync(indexRoot)) {
    rmSync(indexRoot, { recursive: true, force: true });
  }
}

function ensureLocalEvalProjectConfig(projectRoot: string, configPath?: string): string | undefined {
  const localConfigPath = getLocalProjectConfigPath(projectRoot);
  const resolvedConfigPath = configPath
    ? toAbsolute(projectRoot, configPath)
    : resolveProjectConfigPath(projectRoot);

  if (!configPath && existsSync(localConfigPath)) {
    return localConfigPath;
  }

  if (!existsSync(resolvedConfigPath) || resolvedConfigPath === localConfigPath) {
    return resolvedConfigPath;
  }

  const sourceConfig = normalizeEvalConfigKnowledgeBases(
    JSON.parse(readFileSync(resolvedConfigPath, "utf-8")),
    projectRoot,
    resolvedConfigPath,
  );

  mkdirSync(path.dirname(localConfigPath), { recursive: true });
  writeFileSync(localConfigPath, JSON.stringify(sourceConfig, null, 2), "utf-8");
  return localConfigPath;
}

function loadParsedConfig(projectRoot: string, configPath?: string) {
  const raw = loadRawConfig(projectRoot, configPath);
  return parseConfig(raw);
}

function resolveSearchConfig(
  parsedConfig: ReturnType<typeof parseConfig>,
  overrides?: Partial<Pick<ConfigSearchConfig, "fusionStrategy" | "hybridWeight" | "rrfK" | "rerankTopN">>
) {
  const nextSearch: ConfigSearchConfig = {
    ...parsedConfig.search,
  };

  if (overrides?.fusionStrategy !== undefined) {
    nextSearch.fusionStrategy = overrides.fusionStrategy;
  }
  if (overrides?.hybridWeight !== undefined) {
    nextSearch.hybridWeight = overrides.hybridWeight;
  }
  if (overrides?.rrfK !== undefined) {
    nextSearch.rrfK = overrides.rrfK;
  }
  if (overrides?.rerankTopN !== undefined) {
    nextSearch.rerankTopN = overrides.rerankTopN;
  }

  return {
    ...parsedConfig,
    search: nextSearch,
  };
}

export interface EvalRunResult {
  outputDir: string;
  summary: EvalSummary;
  perQuery: PerQueryEvalResult[];
  comparison?: EvalComparison;
  gate?: EvalGateResult;
}

export async function runEvaluation(options: EvalRunOptions): Promise<EvalRunResult> {
  const datasetPath = toAbsolute(options.projectRoot, options.datasetPath);
  const againstPath = options.againstPath ? toAbsolute(options.projectRoot, options.againstPath) : undefined;
  const budgetPath = options.budgetPath ? toAbsolute(options.projectRoot, options.budgetPath) : undefined;

  const dataset = loadGoldenDataset(datasetPath);

  const resolvedEvalConfigPath = options.reindex
    ? ensureLocalEvalProjectConfig(options.projectRoot, options.configPath)
    : options.configPath;

  const parsedConfig = loadParsedConfig(options.projectRoot, resolvedEvalConfigPath);
  const effectiveConfig = resolveSearchConfig(parsedConfig, options.searchOverrides);

  if (options.reindex) {
    clearIndexRoot(options.projectRoot, effectiveConfig.scope);
  }

  const indexer = new Indexer(options.projectRoot, effectiveConfig);

  try {
  await indexer.index();

  const perQuery: PerQueryEvalResult[] = [];

  for (const query of dataset.queries) {
    if (query.expected.branch && query.expected.branch !== indexer.getCurrentBranch()) {
      throw new Error(
        `Query '${query.id}' expects branch '${query.expected.branch}', but current branch is '${indexer.getCurrentBranch()}'. Switch branch before running this dataset.`
      );
    }

    const start = performance.now();
    const result = await indexer.search(query.query, 10, {
      metadataOnly: true,
      filterByBranch: query.expected.branch ? true : false,
    });
    const elapsed = performance.now() - start;

    const materialized = result.map((item) => ({
      filePath: item.filePath,
      startLine: item.startLine,
      endLine: item.endLine,
      score: item.score,
      chunkType: item.chunkType,
      name: item.name,
    }));

    perQuery.push(buildPerQueryResult(query, materialized, elapsed, 10));
  }

  const logger = indexer.getLogger();
  const metricSnapshot = logger.getMetrics();

  const costPer1MTokensUsd =
    effectiveConfig.embeddingProvider === "custom" || effectiveConfig.embeddingProvider === "auto"
      ? 0
      : getDefaultModelForProvider(effectiveConfig.embeddingProvider).costPer1MTokens;

  const summary: EvalSummary = {
    generatedAt: new Date().toISOString(),
    projectRoot: options.projectRoot,
    datasetPath,
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    queryCount: dataset.queries.length,
    topK: 10,
    searchConfig: {
      fusionStrategy: effectiveConfig.search.fusionStrategy,
      hybridWeight: effectiveConfig.search.hybridWeight,
      rrfK: effectiveConfig.search.rrfK,
      rerankTopN: effectiveConfig.search.rerankTopN,
    },
    metrics: computeEvalMetrics(
      dataset.queries,
      perQuery,
      metricSnapshot.embeddingApiCalls,
      metricSnapshot.embeddingTokensUsed,
      costPer1MTokensUsd
    ),
  };

  const outputDir = createRunDirectory(toAbsolute(options.projectRoot, options.outputRoot));
  const perQueryArtifact = buildPerQueryArtifact(perQuery);

  writeJson(path.join(outputDir, "summary.json"), summary);
  writeJson(path.join(outputDir, "per-query.json"), perQueryArtifact);

  let comparison: EvalComparison | undefined;
  if (againstPath) {
    const baseline = loadSummary(againstPath);
    comparison = compareSummaries(summary, baseline, againstPath);
    writeJson(path.join(outputDir, "compare.json"), comparison);
  }

  let gate: EvalGateResult | undefined;
  if (options.ciMode) {
    if (!budgetPath) {
      throw new Error("CI mode requires --budget path");
    }
    const budget = loadBudget(budgetPath);

    if (!comparison && budget.baselinePath) {
      const resolvedBaseline = toAbsolute(options.projectRoot, budget.baselinePath);
      if (existsSync(resolvedBaseline)) {
        const baselineSummary = loadSummary(resolvedBaseline);
        comparison = compareSummaries(summary, baselineSummary, resolvedBaseline);
        writeJson(path.join(outputDir, "compare.json"), comparison);
      } else if (budget.failOnMissingBaseline) {
        throw new Error(
          `Budget baseline is missing: ${resolvedBaseline}. Set failOnMissingBaseline=false to allow CI run without baseline.`
        );
      }
    }

    gate = evaluateBudgetGate(budget, summary, comparison);
  }

  const markdown = createSummaryMarkdown(summary, comparison, gate);
  writeText(path.join(outputDir, "summary.md"), markdown);

  return { outputDir, summary, perQuery, comparison, gate };
  } finally {
    await indexer.close();
  }
}

export async function runSweep(
  options: EvalRunOptions,
  sweep: SweepDefinition
): Promise<{ outputDir: string; aggregate: SweepAggregateReport }> {
  const fusionValues: Array<"rrf" | "weighted" | undefined> =
    sweep.fusionStrategy && sweep.fusionStrategy.length > 0
      ? [...sweep.fusionStrategy]
      : [undefined];
  const weightValues: Array<number | undefined> =
    sweep.hybridWeight && sweep.hybridWeight.length > 0 ? [...sweep.hybridWeight] : [undefined];
  const rrfValues: Array<number | undefined> =
    sweep.rrfK && sweep.rrfK.length > 0 ? [...sweep.rrfK] : [undefined];
  const rerankValues: Array<number | undefined> =
    sweep.rerankTopN && sweep.rerankTopN.length > 0 ? [...sweep.rerankTopN] : [undefined];

  const runs: SweepRunSummary[] = [];

  for (const fusion of fusionValues) {
    for (const hybridWeight of weightValues) {
      for (const rrfK of rrfValues) {
        for (const rerankTopN of rerankValues) {
          const run = await runEvaluation({
            ...options,
            searchOverrides: {
              ...(fusion !== undefined ? { fusionStrategy: fusion } : {}),
              ...(hybridWeight !== undefined ? { hybridWeight } : {}),
              ...(rrfK !== undefined ? { rrfK } : {}),
              ...(rerankTopN !== undefined ? { rerankTopN } : {}),
            },
          });

          runs.push({
            searchConfig: run.summary.searchConfig,
            summary: run.summary,
            comparison: run.comparison,
            gate: run.gate,
          });
        }
      }
    }
  }

  const bestByHitAt5 = [...runs].sort(
    (a, b) => b.summary.metrics.hitAt5 - a.summary.metrics.hitAt5
  )[0];
  const bestByMrrAt10 = [...runs].sort(
    (a, b) => b.summary.metrics.mrrAt10 - a.summary.metrics.mrrAt10
  )[0];
  const bestByP95Latency = [...runs].sort(
    (a, b) => a.summary.metrics.latencyMs.p95 - b.summary.metrics.latencyMs.p95
  )[0];

  const outputDir = createRunDirectory(toAbsolute(options.projectRoot, options.outputRoot));
  const failedGateRuns = runs.filter((run) => run.gate && !run.gate.passed).length;
  const gatePassed = failedGateRuns === 0;
  const aggregate: SweepAggregateReport = {
    generatedAt: new Date().toISOString(),
    againstPath: options.againstPath,
    runCount: runs.length,
    runs,
    gatePassed,
    failedGateRuns,
    bestByHitAt5,
    bestByMrrAt10,
    bestByP95Latency,
  };

  writeJson(path.join(outputDir, "compare.json"), aggregate);
  const md = createSummaryMarkdown(
    bestByHitAt5?.summary ?? runs[0].summary,
    bestByHitAt5?.comparison,
    undefined,
    aggregate
  );
  writeText(path.join(outputDir, "summary.md"), md);
  writeJson(path.join(outputDir, "summary.json"), bestByHitAt5?.summary ?? runs[0].summary);

  return { outputDir, aggregate };
}
