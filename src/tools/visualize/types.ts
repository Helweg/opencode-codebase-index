export interface VisualizationNode {
  id: string;
  name: string;
  filePath: string;
  kind: string;
  line: number;
  directory: string;
  moduleId: string;
  moduleLabel: string;
}

export interface VisualizationEdge {
  source: string;
  target: string;
  callType: string;
  confidence: string;
  line: number;
}

export interface VisualizationModule {
  id: string;
  label: string;
  pathPrefix: string;
  category: "source" | "native" | "test" | "fixture" | "command" | "script" | "doc" | "benchmark" | "other";
  symbolCount: number;
  symbols: string[];
  kinds: Record<string, number>;
}

export interface VisualizationModuleEdge {
  source: string;
  target: string;
  weight: number;
  callTypes: Record<string, number>;
}

export interface VisualizationChange {
  id: string;
  title: string;
  kind: "hot" | "risk" | "legacy";
  when: string;
  source: string;
  intent: string;
  summary: string;
  why: string;
  calls: number;
  churn: number;
  risk: "low" | "medium" | "high";
  moduleId: string;
  focusNodeId?: string;
  filePaths: string[];
}

export interface VisualizationData {
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
  modules: VisualizationModule[];
  moduleEdges: VisualizationModuleEdge[];
  changes?: VisualizationChange[];
  metadata: {
    totalSymbols: number;
    totalEdges: number;
    truncated: boolean;
    directory?: string;
    moduleCount: number;
  };
}
