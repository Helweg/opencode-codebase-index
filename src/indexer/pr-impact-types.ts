export interface PrImpactResult {
  changedFiles: string[];
  directSymbols: Array<{
    id: string;
    name: string;
    kind: string;
    filePath: string;
  }>;
  transitiveCallers: Array<{
    id: string;
    name: string;
    filePath: string;
    depth: number;
  }>;
  totalAffected: number;
  communities: Array<{
    label: string;
    symbolCount: number;
    directSymbols: string[];
  }>;
  hubNodes: Array<{
    id: string;
    name: string;
    callerCount: number;
    filePath: string;
  }>;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  riskReason: string;
  conflictingPRs?: Array<{
    pr: number;
    branch: string;
    overlappingCommunities: string[];
  }>;
  direction?: "callers" | "callees" | "both";
}
