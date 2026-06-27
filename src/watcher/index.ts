import type { CodebaseIndexConfig } from "../config/schema.js";
import type { HostMode } from "../config/host.js";
import { resolveProjectConfigPath, resolveWritableProjectConfigPath } from "../config/paths.js";
import type { Indexer } from "../indexer/index.js";
import { isGitRepo } from "../git/index.js";
import { refreshIndexerForDirectory } from "../tools/operations.js";
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

class BackgroundReindexer {
  private running = false;
  private pending = false;
  private stopped = false;

  constructor(private readonly runIndex: () => Promise<void>) {}

  request(): void {
    if (this.stopped) {
      return;
    }

    this.pending = true;
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
  }

  private drain(): void {
    if (this.stopped || this.running || !this.pending) {
      return;
    }

    this.pending = false;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      await this.runIndex();
    } catch (error) {
      console.error("[codebase-index] Background reindex failed:", error);
    } finally {
      this.running = false;
      this.drain();
    }
  }
}

export function createWatcherWithIndexer(
  getIndexer: () => Indexer,
  projectRoot: string,
  config: CodebaseIndexConfig,
  host: HostMode = "opencode",
): CombinedWatcher {
  const fileWatcher = new FileWatcher(projectRoot, config, host);
  const backgroundReindexer = new BackgroundReindexer(async () => {
    await getIndexer().index();
  });

  fileWatcher.start(async (changes) => {
    const hasAddOrChange = changes.some(
      (c) => c.type === "add" || c.type === "change"
    );
    const hasDelete = changes.some((c) => c.type === "unlink");

    if (hasAddOrChange || hasDelete) {
      const configPaths = [
        resolveProjectConfigPath(projectRoot, host),
        resolveWritableProjectConfigPath(projectRoot, host),
      ].map((configPath) => pathNormalize(configPath));
      if (changes.some((change) => configPaths.includes(pathNormalize(change.path)))) {
        refreshIndexerForDirectory(projectRoot, host);
      }
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

function pathNormalize(value: string): string {
  return value.split("\\").join("/");
}
