import type { CodebaseIndexConfig } from "../config/schema.js";
import type { Indexer } from "../indexer/index.js";
import { isGitRepo } from "../git/index.js";
import { FileWatcher } from "./file-watcher.js";
import { GitHeadWatcher } from "./git-head-watcher.js";

export { FileWatcher } from "./file-watcher.js";
export type { ChangeHandler, FileChange, FileChangeType } from "./file-watcher.js";
export { GitHeadWatcher } from "./git-head-watcher.js";
export type { BranchChangeHandler } from "./git-head-watcher.js";

export interface CombinedWatcher {
  fileWatcher: FileWatcher;
  gitWatcher: GitHeadWatcher | null;
  stop(): void;
}

function normalizeReindexConcurrency(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(4, Math.max(1, Math.floor(value)));
}

class BackgroundReindexer {
  private runningCount = 0;
  private pendingCount = 0;
  private stopped = false;

  constructor(
    private readonly runIndex: () => Promise<void>,
    private readonly concurrency: number
  ) {}

  request(): void {
    if (this.stopped) {
      return;
    }

    this.pendingCount = this.runningCount < this.concurrency
      ? this.pendingCount + 1
      : Math.max(this.pendingCount, 1);
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.pendingCount = 0;
  }

  private drain(): void {
    while (!this.stopped && this.pendingCount > 0 && this.runningCount < this.concurrency) {
      this.pendingCount -= 1;
      this.runningCount += 1;
      void this.run();
    }
  }

  private async run(): Promise<void> {
    try {
      await this.runIndex();
    } catch (error) {
      console.error("[codebase-index] Background reindex failed:", error);
    } finally {
      this.runningCount -= 1;
      this.drain();
    }
  }
}

export function createWatcherWithIndexer(
  getIndexer: () => Indexer,
  projectRoot: string,
  config: CodebaseIndexConfig
): CombinedWatcher {
  const fileWatcher = new FileWatcher(projectRoot, config);
  const backgroundReindexer = new BackgroundReindexer(async () => {
    await getIndexer().index();
  }, normalizeReindexConcurrency(config.indexing?.concurrentReindexRuns));

  fileWatcher.start(async (changes) => {
    const hasAddOrChange = changes.some(
      (c) => c.type === "add" || c.type === "change"
    );
    const hasDelete = changes.some((c) => c.type === "unlink");

    if (hasAddOrChange || hasDelete) {
      backgroundReindexer.request();
    }
  });

  let gitWatcher: GitHeadWatcher | null = null;
  
  if (isGitRepo(projectRoot)) {
    gitWatcher = new GitHeadWatcher(projectRoot);
    gitWatcher.start(async (oldBranch, newBranch) => {
      console.log(`Branch changed: ${oldBranch ?? "(none)"} -> ${newBranch}`);
      backgroundReindexer.request();
    });
  }

  return {
    fileWatcher,
    gitWatcher,
    stop() {
      backgroundReindexer.stop();
      fileWatcher.stop();
      gitWatcher?.stop();
    },
  };
}
