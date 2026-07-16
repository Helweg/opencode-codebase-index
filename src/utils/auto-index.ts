import type { Indexer } from "../indexer/index.js";
import { isTransientIndexLockContention } from "../indexer/index-lock.js";

type AutoIndexTarget = Pick<Indexer, "index">;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startAutoIndex(indexer: AutoIndexTarget, projectRoot: string): void {
  indexer.index().catch((error: unknown) => {
    if (isTransientIndexLockContention(error)) return;
    console.error(`[codebase-index] Auto-index failed for "${projectRoot}": ${getErrorMessage(error)}`);
  });
}
