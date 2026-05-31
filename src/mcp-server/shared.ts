import type { Indexer } from "../indexer/index.js";

export const MAX_CONTENT_LINES = 30;

export function truncateContent(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= MAX_CONTENT_LINES) return content;
  return (
    lines.slice(0, MAX_CONTENT_LINES).join("\n") +
    `\n// ... (${lines.length - MAX_CONTENT_LINES} more lines)`
  );
}

export const CHUNK_TYPE_ENUM = [
  "function", "class", "method", "interface", "type",
  "enum", "struct", "impl", "trait", "module", "other",
] as const;

export interface McpServerRuntime {
  projectRoot: string;
  ensureInitialized(): Promise<void>;
  getIndexer(): Indexer;
  refreshIndexerFromConfig(): void;
  shouldForceLocalizeProjectIndex(): boolean;
}
