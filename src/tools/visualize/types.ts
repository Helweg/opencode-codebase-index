export interface VisualizationNode {
  id: string;
  name: string;
  filePath: string;
  kind: string;
  line: number;
  directory: string;
}

export interface VisualizationEdge {
  source: string;
  target: string;
  callType: string;
  confidence: string;
  line: number;
}

export interface VisualizationData {
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
  metadata: {
    totalSymbols: number;
    totalEdges: number;
    truncated: boolean;
    directory?: string;
  };
}
