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

export function createWatcherWithIndexer(
  getIndexer: () => Indexer,
  projectRoot: string,
  config: CodebaseIndexConfig
): CombinedWatcher {
  const fileWatcher = new FileWatcher(projectRoot, config);

  fileWatcher.start(async (changes) => {
    const hasAddOrChange = changes.some(
      (c) => c.type === "add" || c.type === "change"
    );
    const hasDelete = changes.some((c) => c.type === "unlink");

    if (hasAddOrChange || hasDelete) {
      await getIndexer().index();
    }
  });

  let gitWatcher: GitHeadWatcher | null = null;
  
  if (isGitRepo(projectRoot)) {
    gitWatcher = new GitHeadWatcher(projectRoot);
    gitWatcher.start(async (oldBranch, newBranch) => {
      console.log(`Branch changed: ${oldBranch ?? "(none)"} -> ${newBranch}`);
      await getIndexer().index();
    });
  }

  return {
    fileWatcher,
    gitWatcher,
    stop() {
      fileWatcher.stop();
      gitWatcher?.stop();
    },
  };
}
