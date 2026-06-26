import type {
  VisualizationModule,
  VisualizationModuleEdge,
  VisualizationNode,
} from "./types.js";
import type { VisualizationEdge } from "./types.js";

const MAX_MODULES = 18;
const KNOWN_ROOTS = ["src", "native", "tests", "commands", "scripts", "docs", "benchmarks"];

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/");
}

function stripToProjectRelative(filePath: string): string {
  const normalized = normalizeSlashes(filePath);
  let bestIndex = Number.POSITIVE_INFINITY;
  let bestRoot: string | null = null;
  for (const root of KNOWN_ROOTS) {
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return normalized;
    }

    const marker = `/${root}/`;
    const rootIndex = normalized.indexOf(marker);
    if (rootIndex !== -1 && rootIndex < bestIndex) {
      bestIndex = rootIndex;
      bestRoot = root;
    }
    if (normalized.endsWith(`/${root}`)) {
      return root;
    }
  }
  if (bestRoot !== null && Number.isFinite(bestIndex)) {
    return normalized.slice(bestIndex + 1);
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-3).join("/") || normalized;
}

function modulePrefixFromRelativePath(relativeFilePath: string): string {
  const parts = relativeFilePath.split("/").filter(Boolean);
  if (parts.length === 0) return ".";

  const [root, second, third] = parts;

  if (root === "src") {
    if (!second) return "src";
    const broadBuckets = new Set([
      "config",
      "embeddings",
      "eval",
      "git",
      "indexer",
      "native",
      "rerank",
      "tools",
      "utils",
      "watcher",
    ]);
    if (broadBuckets.has(second)) return `src/${second}`;
    return second ? `src/${second}` : "src";
  }

  if (root === "tests") {
    if (second === "fixtures" && third) return `tests/fixtures/${third}`;
    return second ? `tests/${second}` : "tests";
  }

  if (root === "native") {
    if (second === "src") return "native";
    return second ? `native/${second}` : "native";
  }

  if (root === "commands") return "commands";
  if (root === "scripts") return "scripts";
  if (root === "docs") return second ? `docs/${second}` : "docs";
  if (root === "benchmarks") return second ? `benchmarks/${second}` : "benchmarks";

  return root;
}

function parentModulePrefix(prefix: string): string | null {
  const parts = prefix.split("/");
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
}

function shortLabel(prefix: string, allPrefixes: Set<string>): string {
  const parts = prefix.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const suffix = parts.slice(parts.length - i).join("/");
    const ambiguous = [...allPrefixes].some((candidate) => {
      if (candidate === prefix) return false;
      return candidate.endsWith(`/${suffix}`) || candidate === suffix;
    });
    if (!ambiguous) return suffix;
  }
  return prefix;
}

function classifyModulePrefix(prefix: string): VisualizationModule["category"] {
  if (prefix.startsWith("tests/fixtures")) return "fixture";
  if (prefix.startsWith("tests")) return "test";
  if (prefix === "native" || prefix.startsWith("native/")) return "native";
  if (prefix === "commands" || prefix.startsWith("commands/")) return "command";
  if (prefix === "scripts" || prefix.startsWith("scripts/")) return "script";
  if (prefix === "docs" || prefix.startsWith("docs/")) return "doc";
  if (prefix === "benchmarks" || prefix.startsWith("benchmarks/")) return "benchmark";
  if (prefix === "src" || prefix.startsWith("src/")) return "source";
  return "other";
}

function displayLabelForPrefix(prefix: string, allPrefixes: Set<string>): string {
  const short = shortLabel(prefix, allPrefixes);

  if (prefix.startsWith("tests/fixtures/")) {
    const fixtureName = prefix.slice("tests/fixtures/".length);
    return `fixture: ${fixtureName}`;
  }

  if (prefix === "tests/fixtures") {
    return "fixtures";
  }

  if (prefix.startsWith("tests/")) {
    const testArea = prefix.slice("tests/".length);
    return `tests: ${testArea}`;
  }

  if (prefix === "tests") {
    return "tests";
  }

  if (prefix === "native") {
    return "native";
  }

  return short;
}

function compactModules(prefixToNodes: Map<string, VisualizationNode[]>): Map<string, VisualizationNode[]> {
  const grouped = new Map(prefixToNodes);
  while (grouped.size > MAX_MODULES) {
    const smallest = [...grouped.entries()].sort((a, b) => a[1].length - b[1].length)[0];
    if (!smallest) break;
    const [prefix, members] = smallest;
    const parent = parentModulePrefix(prefix);
    if (!parent) break;
    grouped.delete(prefix);
    if (!grouped.has(parent)) grouped.set(parent, []);
    grouped.get(parent)?.push(...members);
  }
  return grouped;
}

export function deriveModules(nodes: VisualizationNode[]): VisualizationModule[] {
  const initial = new Map<string, VisualizationNode[]>();

  for (const node of nodes) {
    const relative = stripToProjectRelative(node.filePath);
    const prefix = modulePrefixFromRelativePath(relative);
    if (!initial.has(prefix)) initial.set(prefix, []);
    initial.get(prefix)?.push(node);
  }

  const nonFixturePrefixes = [...initial.keys()].filter((prefix) => !prefix.startsWith("tests/fixtures/"));
  if (nonFixturePrefixes.length > 0) {
    const fixtureEntries = [...initial.entries()].filter(([prefix]) => prefix.startsWith("tests/fixtures/"));
    if (fixtureEntries.length > 1) {
      const mergedFixtureNodes = fixtureEntries.flatMap(([, members]) => members);
      for (const [prefix] of fixtureEntries) {
        initial.delete(prefix);
      }
      initial.set("tests/fixtures", mergedFixtureNodes);
    }
  }

  const grouped = compactModules(initial);
  const allPrefixes = new Set(grouped.keys());

  const modules: VisualizationModule[] = [...grouped.entries()]
    .map(([prefix, members]) => {
      const kinds: Record<string, number> = {};
      for (const node of members) {
        kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
      }

      const label = displayLabelForPrefix(prefix, allPrefixes);
      const category = classifyModulePrefix(prefix);
      const id = `module-${prefix.replace(/[^a-zA-Z0-9]+/g, "-")}`;

      for (const node of members) {
        node.moduleId = id;
        node.moduleLabel = label;
      }

      return {
        id,
        label,
        pathPrefix: prefix,
        category,
        symbolCount: members.length,
        symbols: members.map((node) => node.id),
        kinds,
      };
    })
    .sort((a, b) => b.symbolCount - a.symbolCount || a.label.localeCompare(b.label));

  return modules;
}

export function deriveModuleEdges(
  nodes: VisualizationNode[],
  edges: VisualizationEdge[],
): VisualizationModuleEdge[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const aggregate = new Map<string, VisualizationModuleEdge>();

  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    if (!source || !source.moduleId) continue;

    const target = nodeMap.get(edge.target);
    const targetModuleId = target?.moduleId;

    if (!targetModuleId) continue;
    if (source.moduleId === targetModuleId) continue;

    const key = `${source.moduleId}__${targetModuleId}`;
    if (!aggregate.has(key)) {
      aggregate.set(key, {
        source: source.moduleId,
        target: targetModuleId,
        weight: 0,
        callTypes: {},
      });
    }
    const moduleEdge = aggregate.get(key)!;
    moduleEdge.weight += 1;
    moduleEdge.callTypes[edge.callType] = (moduleEdge.callTypes[edge.callType] ?? 0) + 1;
  }

  return [...aggregate.values()].sort((a, b) => b.weight - a.weight);
}
