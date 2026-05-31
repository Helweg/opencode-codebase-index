import { describe, expect, it } from "vitest";

import { rebasePathEntries, resolveInheritedKnowledgeBaseEntries } from "../src/config/rebase.js";

describe("config rebase helpers", () => {
  it("rebases relative path entries from one config root to another", () => {
    expect(
      rebasePathEntries(["docs/reference", " /absent/space "], "/repo/.github", "/repo")
    ).toEqual([".github/docs/reference", "/absent/space"]);
  });

  it("returns an empty array for non-array inputs", () => {
    expect(rebasePathEntries(undefined, "/repo/a", "/repo/b")).toEqual([]);
    expect(resolveInheritedKnowledgeBaseEntries(undefined, "/repo/a", "/repo/b")).toEqual([]);
  });

  it("keeps inherited knowledge base paths relative when they stay inside the source root", () => {
    expect(
      resolveInheritedKnowledgeBaseEntries(["docs/reference"], "/repo", "/repo/worktree")
    ).toEqual(["docs/reference"]);
  });

  it("rebases inherited knowledge base paths when they resolve outside the target root", () => {
    expect(
      resolveInheritedKnowledgeBaseEntries(["../shared/docs"], "/repo/worktree/.opencode", "/repo/worktree")
    ).toEqual(["shared/docs"]);
  });

  it("normalizes absolute inherited knowledge base paths inside the source root to relative form", () => {
    expect(
      resolveInheritedKnowledgeBaseEntries(["/repo/docs/reference"], "/repo", "/repo/worktree")
    ).toEqual(["docs/reference"]);
  });
});
