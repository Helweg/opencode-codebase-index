import * as path from "path";

import type { SymbolData, CallEdgeData } from "../../native/index.js";
import type { VisualizationData, VisualizationNode, VisualizationEdge } from "./types.js";
import { deriveModuleEdges, deriveModules } from "./modules.js";

export interface TransformOptions {
  includeOrphans?: boolean;
  directory?: string;
  maxNodes?: number;
}

export function transformForVisualization(
  symbols: SymbolData[],
  edges: CallEdgeData[],
  options: TransformOptions = {},
): VisualizationData {
  const { includeOrphans = false, directory, maxNodes = 5000 } = options;

  // Filter symbols by directory if specified
  let filteredSymbols = symbols;
  if (directory) {
    const normalizedDir = directory.replace(/\/$/, "");
    const normalizedDirWithSlash = `${normalizedDir}/`;
    const normalizedAbsoluteSuffix = `/${normalizedDirWithSlash}`;
    filteredSymbols = symbols.filter(
      (s) => {
        const normalizedPath = s.filePath.replace(/\\/g, "/");
        return normalizedPath === normalizedDir
          || normalizedPath.startsWith(normalizedDirWithSlash)
          || normalizedPath.endsWith(`/${normalizedDir}`)
          || normalizedPath.includes(normalizedAbsoluteSuffix);
      },
    );
  }

  // Build symbol ID set for filtering edges
  const symbolIdSet = new Set(filteredSymbols.map((s) => s.id));

  // Filter to resolved edges where both source and target are in our symbol set
  const filteredEdges: VisualizationEdge[] = [];
  for (const edge of edges) {
    if (!edge.isResolved || !edge.toSymbolId) continue;
    if (!symbolIdSet.has(edge.fromSymbolId)) continue;
    if (!symbolIdSet.has(edge.toSymbolId)) continue;

    filteredEdges.push({
      source: edge.fromSymbolId,
      target: edge.toSymbolId,
      callType: edge.callType,
      confidence: edge.confidence,
      line: edge.line,
    });
  }

  // Filter orphan nodes if requested
  let finalSymbols = filteredSymbols;
  if (!includeOrphans) {
    const connectedIds = new Set<string>();
    for (const edge of filteredEdges) {
      connectedIds.add(edge.source);
      connectedIds.add(edge.target);
    }
    finalSymbols = filteredSymbols.filter((s) => connectedIds.has(s.id));
  }

  // Check truncation
  const truncated = finalSymbols.length > maxNodes;
  if (truncated) {
    // Keep nodes with most connections
    const connectionCount = new Map<string, number>();
    for (const edge of filteredEdges) {
      connectionCount.set(edge.source, (connectionCount.get(edge.source) ?? 0) + 1);
      connectionCount.set(edge.target, (connectionCount.get(edge.target) ?? 0) + 1);
    }
    finalSymbols = finalSymbols
      .sort((a, b) => (connectionCount.get(b.id) ?? 0) - (connectionCount.get(a.id) ?? 0))
      .slice(0, maxNodes);

    // Re-filter edges to only include remaining nodes
    const remainingIds = new Set(finalSymbols.map((s) => s.id));
    filteredEdges.splice(
      0,
      filteredEdges.length,
      ...filteredEdges.filter((e) => remainingIds.has(e.source) && remainingIds.has(e.target)),
    );
  }

  // Map to visualization nodes
  const nodes: VisualizationNode[] = finalSymbols.map((s) => ({
    id: s.id,
    name: s.name,
    filePath: s.filePath,
    kind: s.kind,
    line: s.startLine,
    directory: path.dirname(s.filePath),
    moduleId: "",
    moduleLabel: "",
  }));

  const modules = deriveModules(nodes);
  const moduleEdges = deriveModuleEdges(nodes, filteredEdges);

  return {
    nodes,
    edges: filteredEdges,
    modules,
    moduleEdges,
    metadata: {
      totalSymbols: symbols.length,
      totalEdges: edges.length,
      truncated,
      directory,
      moduleCount: modules.length,
    },
  };
}
