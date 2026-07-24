import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const operationMocks = vi.hoisted(() => ({
  getCallGraphData: vi.fn(),
  getCallGraphPath: vi.fn(),
  getIndexHealthCheck: vi.fn(),
  runIndexHealthCheck: vi.fn(),
}));

vi.mock("../src/tools/operations.js", () => ({
  addKnowledgeBase: vi.fn(() => "Added knowledge base"),
  findSimilarCode: vi.fn(() => []),
  getCallGraphData: operationMocks.getCallGraphData,
  getCallGraphPath: operationMocks.getCallGraphPath,
  getIndexHealthCheck: operationMocks.getIndexHealthCheck,
  getIndexLogs: vi.fn(() => ({ text: "" })),
  getIndexMetrics: vi.fn(() => ({ text: "" })),
  getIndexStatus: vi.fn(),
  getPrImpact: vi.fn(),
  implementationLookup: vi.fn(() => []),
  listKnowledgeBases: vi.fn(() => "No knowledge bases configured."),
  removeKnowledgeBase: vi.fn(() => "Removed knowledge base"),
  runIndexCodebase: vi.fn(),
  runIndexHealthCheck: operationMocks.runIndexHealthCheck,
  searchCodebase: vi.fn(() => []),
}));

interface RegisteredTool {
  readonly name: string;
  readonly execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx?: { readonly cwd?: string },
  ) => Promise<{ readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>; readonly details?: unknown }>;
}

async function registerPiTools(): Promise<Map<string, RegisteredTool>> {
  const tools = new Map<string, RegisteredTool>();
  const { default: codebaseIndexPiExtension } = await import("../src/pi-extension.js");

  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  } satisfies Pick<ExtensionAPI, "registerTool">;

  codebaseIndexPiExtension(pi);

  return tools;
}

describe("Pi adapter conformance", () => {
  beforeEach(() => {
    operationMocks.getCallGraphData.mockReset();
    operationMocks.getCallGraphPath.mockReset();
    operationMocks.getIndexHealthCheck.mockReset();
    operationMocks.runIndexHealthCheck.mockReset();
  });

  it("formats caller results like other host adapters", async () => {
    operationMocks.getCallGraphData.mockResolvedValue({
      direction: "callers",
      callers: [{
        fromSymbolName: "entryPoint",
        fromSymbolFilePath: "src/app.ts",
        fromSymbolId: "sym_entry",
        callType: "Call",
        confidence: "Direct",
        line: 12,
        isResolved: true,
      }],
      callees: [],
    });
    const tools = await registerPiTools();

    const result = await tools.get("call_graph")?.execute(
      "tool-call",
      { name: "validateToken", direction: "callers" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(result?.content[0]?.text).toContain("\"validateToken\" is called by 1 function(s)");
    expect(result?.content[0]?.text).toContain("entryPoint in src/app.ts");
    expect(result?.details).toEqual(expect.objectContaining({ direction: "callers" }));
  });

  it("formats callee results like other host adapters", async () => {
    operationMocks.getCallGraphData.mockResolvedValue({
      direction: "callees",
      callers: [],
      callees: [{
        targetName: "validateToken",
        toSymbolId: "sym_validate",
        callType: "Call",
        confidence: "Direct",
        line: 21,
        isResolved: true,
      }],
    });
    const tools = await registerPiTools();

    const result = await tools.get("call_graph")?.execute(
      "tool-call",
      { name: "entryPoint", direction: "callees", symbolId: "sym_entry" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(result?.content[0]?.text).toContain("[1] \u2192 validateToken (Call) at line 21 [resolved: sym_validate]");
    expect(result?.details).toEqual(expect.objectContaining({ direction: "callees" }));
  });

  it("formats call path results like other host adapters", async () => {
    operationMocks.getCallGraphPath.mockResolvedValue([
      { symbolName: "createOrder", filePath: "src/order.ts", line: 10, callType: "Call" },
      { symbolName: "chargeCard", filePath: "src/pay.ts", line: 33, callType: "MethodCall" },
    ]);
    const tools = await registerPiTools();

    const result = await tools.get("call_graph_path")?.execute(
      "tool-call",
      { from: "createOrder", to: "chargeCard" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(result?.content[0]?.text).toContain("Path (2 hops):");
    expect(result?.content[0]?.text).toContain("[start] createOrder (src/order.ts:10)");
    expect(result?.content[0]?.text).toContain("--MethodCall--> chargeCard (src/pay.ts:33)");
    expect(result?.details).toHaveLength(2);
  });

  it("returns INDEX_BUSY details from the Pi health-check tool", async () => {
    operationMocks.getIndexHealthCheck.mockRejectedValue(new Error("raw health-check operation must not be used"));
    operationMocks.runIndexHealthCheck.mockResolvedValue({
      kind: "busy",
      text: "INDEX_BUSY: another index operation is already in progress (PID 4444, operation health-check, since 2026-07-17T10:00:00.000Z).",
    });
    const tools = await registerPiTools();

    const result = await tools.get("index_health_check")?.execute(
      "tool-call",
      {},
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(result?.content[0]?.text).toContain("INDEX_BUSY");
    expect(result?.content[0]?.text).toContain("PID 4444");
    expect(result?.details).toEqual({ code: "INDEX_BUSY" });
  });
});
