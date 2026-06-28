import { afterEach, describe, expect, it, vi } from "vitest";

import type { Indexer } from "../src/indexer/index.js";
import { startAutoIndex } from "../src/utils/auto-index.js";

type AutoIndexMock = Pick<Indexer, "initialize" | "index">;

function createIndexerMock(overrides: {
  initialize?: ReturnType<typeof vi.fn>;
  index?: ReturnType<typeof vi.fn>;
}): AutoIndexMock {
  return {
    initialize: overrides.initialize ?? vi.fn().mockResolvedValue(undefined),
    index: overrides.index ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe("startAutoIndex", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs initialization failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const indexer = createIndexerMock({
      initialize: vi.fn().mockRejectedValue(new Error("missing credentials")),
    });

    startAutoIndex(indexer, "/tmp/project");
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());

    expect(consoleError).toHaveBeenCalledWith(
      '[codebase-index] Auto-index initialization failed for "/tmp/project": missing credentials',
    );
  });

  it("indexes after initialization succeeds", async () => {
    const indexer = createIndexerMock({});

    startAutoIndex(indexer, "/tmp/project");
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalled());

    expect(indexer.initialize).toHaveBeenCalledOnce();
    expect(indexer.index).toHaveBeenCalledOnce();
  });

  it("logs indexing failures after initialization succeeds", async () => {
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
