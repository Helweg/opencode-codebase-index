import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const operationMocks = vi.hoisted(() => ({
  getCallGraphData: vi.fn(),
  getCallGraphPath: vi.fn(),
}));

vi.mock("../src/tools/operations.js", () => ({
  addKnowledgeBase: vi.fn(() => "Added knowledge base"),
  findSimilarCode: vi.fn(() => []),
  getCallGraphData: operationMocks.getCallGraphData,
  getCallGraphPath: operationMocks.getCallGraphPath,
  getIndexHealthCheck: vi.fn(),
  getIndexLogs: vi.fn(() => ({ text: "" })),
  getIndexMetrics: vi.fn(() => ({ text: "" })),
  getIndexStatus: vi.fn(),
  getPrImpact: vi.fn(),
  implementationLookup: vi.fn(() => []),
  listKnowledgeBases: vi.fn(() => "No knowledge bases configured."),
  removeKnowledgeBase: vi.fn(() => "Removed knowledge base"),
  runIndexCodebase: vi.fn(),
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
});
