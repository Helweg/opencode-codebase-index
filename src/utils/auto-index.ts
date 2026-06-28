import type { Indexer } from "../indexer/index.js";

type AutoIndexTarget = Pick<Indexer, "initialize" | "index">;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startAutoIndex(indexer: AutoIndexTarget, projectRoot: string): void {
  indexer.initialize().then(() => {
    indexer.index().catch((error: unknown) => {
      console.error(`[codebase-index] Auto-index failed for "${projectRoot}": ${getErrorMessage(error)}`);
    });
  }).catch((error: unknown) => {
    console.error(`[codebase-index] Auto-index initialization failed for "${projectRoot}": ${getErrorMessage(error)}`);
  });
}
