import { readFileSync } from "fs";

import type {
  EvalBudget,
  GoldenDataset,
  GoldenExpected,
  GoldenQuery,
  GoldenQueryType,
} from "./types.js";

function parseJsonFile(filePath: string): unknown {
  const content = readFileSync(filePath, "utf-8");

  try {
    return JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON from ${filePath}: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function asPositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return value;
}

function parseQueryType(value: unknown, path: string): GoldenQueryType {
  if (
    value === "definition" ||
    value === "implementation-intent" ||
    value === "similarity" ||
    value === "keyword-heavy"
  ) {
    return value;
  }
  throw new Error(
    `${path} must be one of: definition, implementation-intent, similarity, keyword-heavy`
  );
}

function parseExpected(input: unknown, path: string): GoldenExpected {
  if (!isRecord(input)) {
    throw new Error(`${path} must be an object`);
  }

  const filePathRaw = input.filePath;
  const acceptableFilesRaw = input.acceptableFiles;
  const symbolRaw = input.symbol;
  const branchRaw = input.branch;

  const filePath = typeof filePathRaw === "string" ? filePathRaw : undefined;
  const acceptableFiles = isStringArray(acceptableFilesRaw) ? acceptableFilesRaw : undefined;

  if (!filePath && (!acceptableFiles || acceptableFiles.length === 0)) {
    throw new Error(`${path} must include either expected.filePath or expected.acceptableFiles`);
  }

  if (acceptableFilesRaw !== undefined && !isStringArray(acceptableFilesRaw)) {
    throw new Error(`${path}.acceptableFiles must be an array of strings`);
  }

  if (symbolRaw !== undefined && typeof symbolRaw !== "string") {
    throw new Error(`${path}.symbol must be a string when provided`);
  }

  if (branchRaw !== undefined && typeof branchRaw !== "string") {
    throw new Error(`${path}.branch must be a string when provided`);
  }

  return {
    filePath,
    acceptableFiles,
    symbol: typeof symbolRaw === "string" ? symbolRaw : undefined,
    branch: typeof branchRaw === "string" ? branchRaw : undefined,
  };
}

function parseQuery(input: unknown, index: number): GoldenQuery {
  const path = `queries[${index}]`;
  if (!isRecord(input)) {
    throw new Error(`${path} must be an object`);
  }

  const id = input.id;
  const query = input.query;
  const queryType = input.queryType;
  const expected = input.expected;

  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`${path}.id must be a non-empty string`);
  }

  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error(`${path}.query must be a non-empty string`);
  }

  return {
    id,
    query,
    queryType: parseQueryType(queryType, `${path}.queryType`),
    expected: parseExpected(expected, `${path}.expected`),
  };
}

export function parseGoldenDataset(raw: unknown, sourceLabel: string): GoldenDataset {
  if (!isRecord(raw)) {
    throw new Error(`${sourceLabel} must be a JSON object`);
  }

  const version = raw.version;
  const name = raw.name;
  const description = raw.description;
  const queriesRaw = raw.queries;

  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(`${sourceLabel}.version must be a non-empty string`);
  }

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${sourceLabel}.name must be a non-empty string`);
  }

  if (description !== undefined && typeof description !== "string") {
    throw new Error(`${sourceLabel}.description must be a string when provided`);
  }

  if (!Array.isArray(queriesRaw)) {
    throw new Error(`${sourceLabel}.queries must be an array`);
  }

  if (queriesRaw.length === 0) {
    throw new Error(`${sourceLabel}.queries must contain at least one query`);
  }

  const queries = queriesRaw.map((query, idx) => parseQuery(query, idx));
  const idSet = new Set<string>();

  for (const query of queries) {
    if (idSet.has(query.id)) {
      throw new Error(`${sourceLabel}.queries has duplicate id: ${query.id}`);
    }
    idSet.add(query.id);
  }

  return {
    version,
    name,
    description: typeof description === "string" ? description : undefined,
    queries,
  };
}

export function loadGoldenDataset(datasetPath: string): GoldenDataset {
  const parsed = parseJsonFile(datasetPath);
  return parseGoldenDataset(parsed, datasetPath);
}

export function parseBudget(raw: unknown, sourceLabel: string): EvalBudget {
  if (!isRecord(raw)) {
    throw new Error(`${sourceLabel} must be a JSON object`);
  }

  const name = raw.name;
  const baselinePath = raw.baselinePath;
  const failOnMissingBaseline = raw.failOnMissingBaseline;
  const thresholds = raw.thresholds;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${sourceLabel}.name must be a non-empty string`);
  }

  if (baselinePath !== undefined && typeof baselinePath !== "string") {
    throw new Error(`${sourceLabel}.baselinePath must be a string when provided`);
  }

  if (!isRecord(thresholds)) {
    throw new Error(`${sourceLabel}.thresholds must be an object`);
  }

  return {
    name,
    baselinePath: typeof baselinePath === "string" ? baselinePath : undefined,
    failOnMissingBaseline:
      typeof failOnMissingBaseline === "boolean" ? failOnMissingBaseline : true,
    thresholds: {
      hitAt5MaxDrop:
        thresholds.hitAt5MaxDrop === undefined
          ? undefined
          : asPositiveNumber(thresholds.hitAt5MaxDrop, `${sourceLabel}.thresholds.hitAt5MaxDrop`),
      mrrAt10MaxDrop:
        thresholds.mrrAt10MaxDrop === undefined
          ? undefined
          : asPositiveNumber(thresholds.mrrAt10MaxDrop, `${sourceLabel}.thresholds.mrrAt10MaxDrop`),
      rawDistinctTop3RatioMaxDrop:
        thresholds.rawDistinctTop3RatioMaxDrop === undefined
          ? undefined
          : asPositiveNumber(
              thresholds.rawDistinctTop3RatioMaxDrop,
              `${sourceLabel}.thresholds.rawDistinctTop3RatioMaxDrop`
            ),
      p95LatencyMaxMultiplier:
        thresholds.p95LatencyMaxMultiplier === undefined
          ? undefined
          : asPositiveNumber(
              thresholds.p95LatencyMaxMultiplier,
              `${sourceLabel}.thresholds.p95LatencyMaxMultiplier`
            ),
      p95LatencyMaxAbsoluteMs:
        thresholds.p95LatencyMaxAbsoluteMs === undefined
          ? undefined
          : asPositiveNumber(
              thresholds.p95LatencyMaxAbsoluteMs,
              `${sourceLabel}.thresholds.p95LatencyMaxAbsoluteMs`
            ),
      minHitAt5:
        thresholds.minHitAt5 === undefined
          ? undefined
          : asPositiveNumber(thresholds.minHitAt5, `${sourceLabel}.thresholds.minHitAt5`),
      minMrrAt10:
        thresholds.minMrrAt10 === undefined
          ? undefined
          : asPositiveNumber(thresholds.minMrrAt10, `${sourceLabel}.thresholds.minMrrAt10`),
      minRawDistinctTop3Ratio:
        thresholds.minRawDistinctTop3Ratio === undefined
          ? undefined
          : asPositiveNumber(
              thresholds.minRawDistinctTop3Ratio,
              `${sourceLabel}.thresholds.minRawDistinctTop3Ratio`
            ),
    },
  };
}

export function loadBudget(budgetPath: string): EvalBudget {
  const parsed = parseJsonFile(budgetPath);
  return parseBudget(parsed, budgetPath);
}
