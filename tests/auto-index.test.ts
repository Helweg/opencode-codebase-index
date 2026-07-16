import { afterEach, describe, expect, it, vi } from "vitest";

import type { Indexer } from "../src/indexer/index.js";
import { IndexLockContentionError } from "../src/indexer/index-lock.js";
import { startAutoIndex } from "../src/utils/auto-index.js";

type AutoIndexMock = Pick<Indexer, "index">;

function createIndexerMock(overrides: {
  index?: ReturnType<typeof vi.fn>;
}): AutoIndexMock {
  return {
    index: overrides.index ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe("startAutoIndex", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("indexes through the single lease that also initializes", async () => {
    const indexer = createIndexerMock({});

    startAutoIndex(indexer, "/tmp/project");
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalled());

    expect(indexer.index).toHaveBeenCalledOnce();
  });

  it("coalesces INDEX_BUSY without logging an error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = {
      pid: process.pid,
      hostname: "local-test",
      startedAt: new Date().toISOString(),
      operation: "index" as const,
      token: "busy-owner",
    };
    const indexer = createIndexerMock({
      index: vi.fn().mockRejectedValue(new IndexLockContentionError("/tmp/indexing.lock", owner, "active")),
    });

    startAutoIndex(indexer, "/tmp/project");
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs non-transient lock states that require intervention", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = {
      pid: process.pid,
      hostname: "local-test",
      startedAt: new Date().toISOString(),
      operation: "index" as const,
      token: "legacy-owner",
    };
    const indexer = createIndexerMock({
      index: vi.fn().mockRejectedValue(new IndexLockContentionError("/tmp/indexing.lock", owner, "legacy-lock")),
    });

    startAutoIndex(indexer, "/tmp/project");
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Auto-index failed"),
    );
  });

  it("logs real indexing failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const indexer = createIndexerMock({
      index: vi.fn().mockRejectedValue(new Error("database is malformed")),
    });

    startAutoIndex(indexer, "/tmp/project");
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());

    expect(consoleError).toHaveBeenCalledWith(
      '[codebase-index] Auto-index failed for "/tmp/project": database is malformed',
    );
  });
});
