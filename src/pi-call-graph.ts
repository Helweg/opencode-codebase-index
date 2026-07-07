import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getCallGraphData, getCallGraphPath } from "./tools/operations.js";
import { formatCallGraphCallees, formatCallGraphCallers, formatCallGraphPath } from "./tools/utils.js";

const HOST = "pi" as const;

const RelationshipType = Type.Union([
  Type.Literal("Call"),
  Type.Literal("MethodCall"),
  Type.Literal("Constructor"),
  Type.Literal("Import"),
  Type.Literal("Inherits"),
  Type.Literal("Implements"),
]);

function text(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function projectRoot(ctx: { cwd?: string } | undefined): string | undefined {
  return ctx?.cwd ?? process.cwd();
}

export function registerPiCallGraphTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "call_graph",
    label: "Call Graph",
    description: "Find callers or callees of a function/method in the indexed call graph.",
    parameters: Type.Object({
      name: Type.String(),
      direction: Type.Optional(Type.Union([Type.Literal("callers"), Type.Literal("callees")])),
      symbolId: Type.Optional(Type.String()),
      relationshipType: Type.Optional(RelationshipType),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getCallGraphData(projectRoot(ctx), HOST, params);
      if (result.direction === "callees") {
        return text(
          params.symbolId
            ? formatCallGraphCallees(params.symbolId, result.callees, params.relationshipType)
            : "Error: 'symbolId' is required when direction is 'callees'.",
          result,
        );
      }

      return text(formatCallGraphCallers(params.name, result.callers, params.relationshipType), result);
    },
  });

  pi.registerTool({
    name: "call_graph_path",
    label: "Call Graph Path",
    description: "Find a call path between two functions/methods.",
    parameters: Type.Object({
      from: Type.String(),
      to: Type.String(),
      maxDepth: Type.Optional(Type.Number({ default: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getCallGraphPath(projectRoot(ctx), HOST, params.from, params.to, params.maxDepth);
      return text(formatCallGraphPath(params.from, params.to, result), result);
    },
  });
}
