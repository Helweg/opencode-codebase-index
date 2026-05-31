import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectBranchRefs, readPackedRefs, resolveCommonGitDir, tryResolveRefCommit } from "../src/git/refs.js";

describe("git ref helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads packed refs while skipping comments and peeled entries", () => {
    fs.writeFileSync(
      path.join(tempDir, "packed-refs"),
      "# pack-refs with: peeled\n111 refs/heads/main\n^222\n333 refs/heads/dev\n",
      "utf-8"
    );

    expect(readPackedRefs(tempDir)).toEqual(["111 refs/heads/main", "333 refs/heads/dev"]);
  });

  it("resolves common git dir via commondir file when present", () => {
    const commonDir = path.join(tempDir, "..", "main-repo", ".git");
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "commondir"), commonDir, "utf-8");

    expect(resolveCommonGitDir(tempDir)).toBe(commonDir);
  });

  it("resolves loose refs before packed refs", () => {
    fs.mkdirSync(path.join(tempDir, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "refs", "heads", "main"), "a".repeat(40), "utf-8");
    fs.writeFileSync(path.join(tempDir, "packed-refs"), `${"b".repeat(40)} refs/heads/main\n`, "utf-8");

    expect(tryResolveRefCommit(tempDir, "refs/heads/main")).toBe("a".repeat(40));
  });

  it("falls back to packed refs when loose refs are absent", () => {
    fs.writeFileSync(path.join(tempDir, "packed-refs"), `${"c".repeat(40)} refs/heads/main\n`, "utf-8");

    expect(tryResolveRefCommit(tempDir, "refs/heads/main")).toBe("c".repeat(40));
  });

  it("collects nested branch refs", () => {
    fs.mkdirSync(path.join(tempDir, "feature", "x"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "main"), "1", "utf-8");
    fs.writeFileSync(path.join(tempDir, "feature", "x", "y"), "2", "utf-8");

    const branches: string[] = [];
    collectBranchRefs(branches, tempDir);

    expect(branches.sort()).toEqual(["feature/x/y", "main"]);
  });
});
