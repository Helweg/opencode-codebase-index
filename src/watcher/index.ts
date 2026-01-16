import chokidar, { FSWatcher } from "chokidar";
import * as path from "path";

import { CodebaseIndexConfig } from "../config/schema.js";
import { createIgnoreFilter, shouldIncludeFile } from "../utils/files.js";
import { Indexer } from "../indexer/index.js";
import { isGitRepo, getHeadPath, getCurrentBranch } from "../git/index.js";

export type FileChangeType = "add" | "change" | "unlink";
export type BranchChangeHandler = (oldBranch: string | null, newBranch: string) => Promise<void>;

export interface FileChange {
  type: FileChangeType;
  path: string;
}

export type ChangeHandler = (changes: FileChange[]) => Promise<void>;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private config: CodebaseIndexConfig;
  private pendingChanges: Map<string, FileChangeType> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs = 1000;
  private onChanges: ChangeHandler | null = null;

  constructor(projectRoot: string, config: CodebaseIndexConfig) {
    this.projectRoot = projectRoot;
    this.config = config;
  }

  start(handler: ChangeHandler): void {
    if (this.watcher) {
      return;
    }

    this.onChanges = handler;
    const ignoreFilter = createIgnoreFilter(this.projectRoot);

    this.watcher = chokidar.watch(this.projectRoot, {
      ignored: (filePath: string) => {
        const relativePath = path.relative(this.projectRoot, filePath);
        if (!relativePath) return false;

        if (ignoreFilter.ignores(relativePath)) {
          return true;
        }

        return false;
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (filePath) => this.handleChange("add", filePath));
    this.watcher.on("change", (filePath) => this.handleChange("change", filePath));
    this.watcher.on("unlink", (filePath) => this.handleChange("unlink", filePath));
  }

  private handleChange(type: FileChangeType, filePath: string): void {
    if (
      !shouldIncludeFile(
        filePath,
        this.projectRoot,
        this.config.include,
        this.config.exclude,
        createIgnoreFilter(this.projectRoot)
      )
    ) {
      return;
    }

    this.pendingChanges.set(filePath, type);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.pendingChanges.size === 0 || !this.onChanges) {
      return;
    }

    const changes: FileChange[] = Array.from(this.pendingChanges.entries()).map(
      ([path, type]) => ({ path, type })
    );

    this.pendingChanges.clear();

    try {
      await this.onChanges(changes);
    } catch (error) {
      console.error("Error handling file changes:", error);
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.pendingChanges.clear();
    this.onChanges = null;
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }
}

/**
 * Watches .git/HEAD for branch changes.
 * When HEAD changes (branch switch, checkout), triggers callback with old and new branch.
 */
export class GitHeadWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private currentBranch: string | null = null;
  private onBranchChange: BranchChangeHandler | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs = 100; // Short debounce for git operations

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  start(handler: BranchChangeHandler): void {
    if (this.watcher) {
      return;
    }

    if (!isGitRepo(this.projectRoot)) {
      return; // Not a git repo, nothing to watch
    }

    this.onBranchChange = handler;
    this.currentBranch = getCurrentBranch(this.projectRoot);

    const headPath = getHeadPath(this.projectRoot);
    
    // Also watch refs/heads for when branches are updated
    const refsPath = path.join(this.projectRoot, ".git", "refs", "heads");

    this.watcher = chokidar.watch([headPath, refsPath], {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });

    this.watcher.on("change", () => this.handleHeadChange());
    this.watcher.on("add", () => this.handleHeadChange());
  }

  private handleHeadChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.checkBranchChange();
    }, this.debounceMs);
  }

  private async checkBranchChange(): Promise<void> {
    const newBranch = getCurrentBranch(this.projectRoot);
    
    if (newBranch && newBranch !== this.currentBranch && this.onBranchChange) {
      const oldBranch = this.currentBranch;
      this.currentBranch = newBranch;
      
      try {
        await this.onBranchChange(oldBranch, newBranch);
      } catch (error) {
        console.error("Error handling branch change:", error);
      }
    } else if (newBranch) {
      this.currentBranch = newBranch;
    }
  }

  getCurrentBranch(): string | null {
    return this.currentBranch;
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.onBranchChange = null;
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }
}

export interface CombinedWatcher {
  fileWatcher: FileWatcher;
  gitWatcher: GitHeadWatcher | null;
  stop(): void;
}

export function createWatcherWithIndexer(
  indexer: Indexer,
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
      await indexer.index();
    }
  });

  let gitWatcher: GitHeadWatcher | null = null;
  
  if (isGitRepo(projectRoot)) {
    gitWatcher = new GitHeadWatcher(projectRoot);
    gitWatcher.start(async (oldBranch, newBranch) => {
      console.log(`Branch changed: ${oldBranch ?? "(none)"} -> ${newBranch}`);
      await indexer.index();
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
