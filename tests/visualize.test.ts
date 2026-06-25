import { describe, it, expect } from "vitest";
import { attachRecentActivity } from "../src/tools/visualize/activity.js";
import { transformForVisualization } from "../src/tools/visualize/transform.js";
import { generateVisualizationHtml } from "../src/tools/visualize/template.js";
import type { SymbolData, CallEdgeData } from "../src/native/index.js";

function makeSymbol(id: string, name: string, filePath: string, kind = "function"): SymbolData {
  return {
    id,
    name,
    filePath,
    kind,
    startLine: 1,
    startCol: 0,
    endLine: 10,
    endCol: 1,
    language: "typescript",
  };
}

function makeEdge(
  id: string,
  fromSymbolId: string,
  targetName: string,
  toSymbolId: string | undefined,
  callType = "Call",
  isResolved = true,
): CallEdgeData {
  return {
    id,
    fromSymbolId,
    fromSymbolName: undefined,
    fromSymbolFilePath: undefined,
    targetName,
    toSymbolId,
    callType,
    confidence: "Direct",
    line: 5,
    col: 10,
    isResolved,
  };
}

describe("visualize - transform", () => {
  const symbols: SymbolData[] = [
    makeSymbol("sym1", "handleRequest", "src/handlers/request.ts"),
    makeSymbol("sym2", "validateInput", "src/utils/validate.ts"),
    makeSymbol("sym3", "logError", "src/utils/logger.ts"),
    makeSymbol("sym4", "parseConfig", "src/config/parser.ts"),
    makeSymbol("sym5", "orphanFn", "src/orphan.ts"),
  ];

  const edges: CallEdgeData[] = [
    makeEdge("e1", "sym1", "validateInput", "sym2", "Call"),
    makeEdge("e2", "sym1", "logError", "sym3", "Call"),
    makeEdge("e3", "sym2", "parseConfig", "sym4", "Call"),
    makeEdge("e4", "sym1", "unresolvedFn", undefined, "Call", false),
  ];

  it("filters unresolved edges", () => {
    const result = transformForVisualization(symbols, edges);
    // e4 is unresolved, should be excluded
    expect(result.edges.length).toBe(3);
    expect(result.edges.every((e) => e.source && e.target)).toBe(true);
  });

  it("excludes orphan nodes by default", () => {
    const result = transformForVisualization(symbols, edges);
    // sym5 has no edges, should be excluded
    expect(result.nodes.find((n) => n.id === "sym5")).toBeUndefined();
    expect(result.nodes.length).toBe(4);
  });

  it("includes orphan nodes when requested", () => {
    const result = transformForVisualization(symbols, edges, { includeOrphans: true });
    expect(result.nodes.find((n) => n.id === "sym5")).toBeDefined();
    expect(result.nodes.length).toBe(5);
  });

  it("filters by directory", () => {
    const result = transformForVisualization(symbols, edges, { directory: "src/utils" });
    // Only sym2 and sym3 are in src/utils, and only edge e3 connects sym2→sym4 (sym4 not in src/utils)
    // Edge e1: sym1→sym2 (sym1 not in src/utils, filtered)
    // Edge e2: sym1→sym3 (sym1 not in src/utils, filtered)
    // Edge e3: sym2→sym4 (sym4 not in src/utils, filtered)
    // No edges remain with both ends in src/utils
    expect(result.nodes.length).toBe(0);
  });

  it("filters absolute indexed paths by repo-relative directory", () => {
    const root = "/tmp/example-repo";
    const absoluteSymbols: SymbolData[] = [
      makeSymbol("sym1", "handleRequest", `${root}/src/handlers/request.ts`),
      makeSymbol("sym2", "validateInput", `${root}/src/utils/validate.ts`),
      makeSymbol("sym3", "logError", `${root}/src/utils/logger.ts`),
      makeSymbol("sym4", "testHelper", `${root}/tests/helper.ts`),
    ];
    const absoluteEdges: CallEdgeData[] = [
      makeEdge("e1", "sym2", "logError", "sym3", "Call"),
      makeEdge("e2", "sym4", "handleRequest", "sym1", "Call"),
    ];

    const result = transformForVisualization(absoluteSymbols, absoluteEdges, { directory: "src" });

    expect(result.nodes.map((node) => node.name).sort()).toEqual(["logError", "validateInput"]);
    expect(result.edges).toHaveLength(1);
  });

  it("filters by directory with connected nodes", () => {
    // Add an edge between two nodes in the same directory
    const extraEdges = [
      ...edges,
      makeEdge("e5", "sym2", "logError", "sym3", "Call"),
    ];
    const result = transformForVisualization(symbols, extraEdges, { directory: "src/utils" });
    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(1);
  });

  it("truncates to maxNodes keeping most-connected", () => {
    const result = transformForVisualization(symbols, edges, { maxNodes: 2 });
    // sym1 has 2 outgoing edges (most connected), sym2 has 1 in + 1 out
    expect(result.nodes.length).toBeLessThanOrEqual(2);
    expect(result.metadata.truncated).toBe(true);
  });

  it("sets correct metadata", () => {
    const result = transformForVisualization(symbols, edges);
    expect(result.metadata.totalSymbols).toBe(5);
    expect(result.metadata.totalEdges).toBe(4);
    expect(result.metadata.truncated).toBe(false);
    expect(result.metadata.moduleCount).toBeGreaterThan(0);
  });

  it("adds graph-derived change lenses when git activity is unavailable", () => {
    const result = attachRecentActivity(
      transformForVisualization(symbols, edges),
      "/path/that/does/not/exist",
    );

    expect(result.changes?.length).toBeGreaterThan(0);
    expect(result.changes?.[0]?.source).toBe("call graph");
    expect(result.changes?.[0]?.focusNodeId).toBeTruthy();
  });

  it("extracts directory from filePath", () => {
    const result = transformForVisualization(symbols, edges);
    const reqNode = result.nodes.find((n) => n.name === "handleRequest");
    expect(reqNode?.directory).toBe("src/handlers");
  });

  it("derives module metadata for nodes", () => {
    const result = transformForVisualization(symbols, edges, { includeOrphans: true });
    expect(result.modules.length).toBeGreaterThan(0);
    expect(result.nodes.every((node) => node.moduleId.length > 0)).toBe(true);
    expect(result.nodes.every((node) => node.moduleLabel.length > 0)).toBe(true);
    expect(result.modules.every((module) => module.category.length > 0)).toBe(true);
  });

  it("labels fixture-derived modules explicitly", () => {
    const fixtureSymbols: SymbolData[] = [
      makeSymbol("fixture1", "fixtureFn", "tests/fixtures/call-graph/sample.ts"),
      makeSymbol("runtime1", "runtimeFn", "src/indexer/runtime.ts"),
    ];

    const fixtureEdges: CallEdgeData[] = [
      makeEdge("e1", "fixture1", "runtimeFn", "runtime1", "Call"),
    ];

    const result = transformForVisualization(fixtureSymbols, fixtureEdges, { includeOrphans: true });
    const fixtureModule = result.modules.find((module) => module.pathPrefix === "tests/fixtures/call-graph");

    expect(fixtureModule?.label).toBe("fixture: call-graph");
    expect(fixtureModule?.category).toBe("fixture");
  });

  it("aggregates module-level edges", () => {
    const result = transformForVisualization(symbols, edges, { includeOrphans: true });
    expect(Array.isArray(result.moduleEdges)).toBe(true);
    expect(result.moduleEdges.every((edge) => edge.weight > 0)).toBe(true);
  });

  it("does not derive module-level edges from unresolved calls", () => {
    const unresolvedOnly: CallEdgeData[] = [
      makeEdge("e1", "sym1", "parseConfig", undefined, "Call", false),
    ];

    const result = transformForVisualization(symbols, unresolvedOnly, { includeOrphans: true });

    expect(result.edges).toHaveLength(0);
    expect(result.moduleEdges).toHaveLength(0);
  });
});

describe("visualize - HTML template", () => {
  it("generates valid HTML", () => {
    const data = transformForVisualization(
      [
        makeSymbol("s1", "foo", "src/a.ts"),
        makeSymbol("s2", "bar", "src/b.ts"),
      ],
      [makeEdge("e1", "s1", "bar", "s2")],
      { includeOrphans: true },
    );

    const html = generateVisualizationHtml(data);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<canvas");
    expect(html).toContain("Call Graph Visualization");
    expect(html).toContain("Moving lately");
    expect(html).toContain("change lenses");
    expect(html).toContain('"name":"foo"');
    expect(html).toContain('"name":"bar"');
    expect(html).toContain('"modules"');
    expect(html).toContain('"moduleEdges"');
  });

  it("handles empty data", () => {
    const data = {
      nodes: [],
      edges: [],
      modules: [],
      moduleEdges: [],
      metadata: { totalSymbols: 0, totalEdges: 0, truncated: false, moduleCount: 0 },
    };
    const html = generateVisualizationHtml(data);
    expect(html).toContain("<!DOCTYPE html>");
    // Data is embedded as JSON, stats are computed at runtime from nodes.length
    expect(html).toContain('"nodes":[]');
    expect(html).toContain('"modules"');
  });

  it("escapes special characters in symbol names", () => {
    const data = transformForVisualization(
      [
        makeSymbol("s1", '<script>alert("xss")</script>', "src/a.ts"),
        makeSymbol("s2", "normalFn", "src/b.ts"),
      ],
      [makeEdge("e1", "s1", "normalFn", "s2")],
    );

    const html = generateVisualizationHtml(data);
    // JSON.stringify should escape the angle brackets
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("\\u003c"); // JSON-escaped <
  });

  it("includes truncation warning data when truncated", () => {
    const data = {
      nodes: [{ id: "s1", name: "fn1", filePath: "a.ts", kind: "function", line: 1, directory: "." }],
      edges: [],
      metadata: { totalSymbols: 10000, totalEdges: 5000, truncated: true },
    };
    const html = generateVisualizationHtml(data);
    expect(html).toContain('"truncated":true');
  });

  it("generates visualization with multiple edge types", () => {
    const symbols: SymbolData[] = [
      makeSymbol("s1", "ClassA", "src/a.ts", "class"),
      makeSymbol("s2", "ClassB", "src/b.ts", "class"),
      makeSymbol("s3", "helper", "src/c.ts", "function"),
    ];
    const edges: CallEdgeData[] = [
      makeEdge("e1", "s1", "ClassB", "s2", "Constructor"),
      makeEdge("e2", "s1", "helper", "s3", "Call"),
      makeEdge("e3", "s2", "helper", "s3", "MethodCall"),
    ];
    const data = transformForVisualization(symbols, edges);
    const html = generateVisualizationHtml(data);

    expect(html).toContain('"callType":"Constructor"');
    expect(html).toContain('"callType":"Call"');
    expect(html).toContain('"callType":"MethodCall"');
  });

  it("includes focus navigation hint and scroll handler", () => {
    const data = transformForVisualization(
      [
        makeSymbol("s1", "foo", "src/a.ts"),
        makeSymbol("s2", "bar", "src/b.ts"),
      ],
      [makeEdge("e1", "s1", "bar", "s2")],
      { includeOrphans: true },
    );

    const html = generateVisualizationHtml(data);

    expect(html).toContain("Scroll to pan vertically inside focus mode");
    expect(html).toContain('canvas.addEventListener("wheel"');
  });

  it("includes clustered exploration controls", () => {
    const data = transformForVisualization(
      [
        makeSymbol("s1", "foo", "src/a.ts"),
        makeSymbol("s2", "bar", "src/b.ts"),
      ],
      [makeEdge("e1", "s1", "bar", "s2")],
      { includeOrphans: true },
    );

    const html = generateVisualizationHtml(data);

    expect(html).toContain("Explore Symbols");
    expect(html).toContain("Explore mode: clustered symbol relationships");
    expect(html).toContain("clustered symbol exploration view");
    expect(html).toContain("Module Overview");
    expect(html).toContain("View Options");
  });

  it("includes zero-edge overview guidance and focus detail behavior", () => {
    const data = transformForVisualization(
      [
        makeSymbol("s1", "soloA", "src/a.ts"),
        makeSymbol("s2", "soloB", "src/b.ts"),
      ],
      [makeEdge("e1", "s1", "soloB", "s2")],
      { includeOrphans: true },
    );

    const html = generateVisualizationHtml({
      ...data,
      moduleEdges: [],
    });

    expect(html).toContain("This slice only has intra-module calls.");
    expect(html).toContain("Focused module view");
    expect(html).toContain("Selected from module list");
  });
});
