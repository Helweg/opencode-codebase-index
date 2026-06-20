import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { getChangedFiles } from "../src/tools/changed-files.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile as typeof execFile);

interface MockResponse {
  command?: string;
  args?: string[];
  stdout?: string;
  stderr?: string;
  error?: Error;
}

function mockExecFile(responses: MockResponse[]): void {
  let callIndex = 0;
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (cmd: string, args: string[], _options: unknown, callback: unknown) => {
      const response = responses[callIndex];
      callIndex += 1;

      if (response === undefined) {
        return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
          new Error(`Unexpected execFile call: ${cmd} ${JSON.stringify(args)}`),
        );
      }

      if (response.error !== undefined) {
        return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
          response.error,
        );
      }

      if (response.command !== undefined && response.command !== cmd) {
        return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
          new Error(`Expected command ${response.command}, got ${cmd}`),
        );
      }

      if (response.args !== undefined && JSON.stringify(response.args) !== JSON.stringify(args)) {
        return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
          new Error(`Expected args ${JSON.stringify(response.args)}, got ${JSON.stringify(args)}`),
        );
      }

      return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
        null,
        { stdout: response.stdout ?? "", stderr: response.stderr ?? "" },
      );
    },
  );
}

describe("getChangedFiles", () => {
  const projectRoot = "/test/project";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns changed files for a branch via git", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "main", "feature/x"], stdout: "abc123\n" },
      { command: "git", args: ["diff", "--name-only", "abc123...feature/x"], stdout: "src/a.ts\nsrc/b.ts\n" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/x",
      projectRoot,
    });

    expect(result.source).toBe("git");
    expect(result.baseBranch).toBe("main");
    expect(result.headRefName).toBe("feature/x");
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("uses the current branch when no branch is provided", async () => {
    mockExecFile([
      { command: "git", args: ["branch", "--show-current"], stdout: "feature/current\n" },
      { command: "git", args: ["merge-base", "main", "feature/current"], stdout: "def456\n" },
      { command: "git", args: ["diff", "--name-only", "def456...feature/current"], stdout: "README.md\n" },
    ]);

    const result = await getChangedFiles({ projectRoot });

    expect(result.source).toBe("git");
    expect(result.headRefName).toBe("feature/current");
    expect(result.files).toEqual(["README.md"]);
  });

  it("extracts files from gh pr view when available", async () => {
    mockExecFile([
      {
        command: "gh",
        args: ["pr", "view", "42", "--json", "headRefName,baseRefName,files"],
        stdout: JSON.stringify({
          headRefName: "feature/pr-42",
          baseRefName: "main",
          files: [{ path: "src/pr.ts" }, { path: "tests/pr.test.ts" }],
        }),
      },
    ]);

    const result = await getChangedFiles({ pr: 42, projectRoot });

    expect(result.source).toBe("gh");
    expect(result.baseBranch).toBe("main");
    expect(result.headRefName).toBe("feature/pr-42");
    expect(result.files).toEqual(["src/pr.ts", "tests/pr.test.ts"]);
  });

  it("throws when gh pr view fails", async () => {
    mockExecFile([
      {
        command: "gh",
        args: ["pr", "view", "99", "--json", "headRefName,baseRefName,files"],
        error: new Error("GraphQL: Could not resolve to a PullRequest"),
      },
    ]);

    await expect(
      getChangedFiles({ pr: 99, projectRoot }),
    ).rejects.toThrow("Failed to retrieve PR #99 via gh CLI");
  });

  it("handles empty diffs gracefully", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "main", "feature/empty"], stdout: "base789\n" },
      { command: "git", args: ["diff", "--name-only", "base789...feature/empty"], stdout: "\n" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/empty",
      projectRoot,
    });

    expect(result.files).toEqual([]);
    expect(result.headRefName).toBe("feature/empty");
  });

  it("strips leading ./ from file paths", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "main", "feature/dotslash"], stdout: "base000\n" },
      { command: "git", args: ["diff", "--name-only", "base000...feature/dotslash"], stdout: "./src/file.ts\n" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/dotslash",
      projectRoot,
    });

    expect(result.files).toEqual(["src/file.ts"]);
    expect(result.headRefName).toBe("feature/dotslash");
  });

  it("deduplicates repeated file paths", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "main", "feature/dup"], stdout: "base111\n" },
      { command: "git", args: ["diff", "--name-only", "base111...feature/dup"], stdout: "src/a.ts\nsrc/a.ts\nsrc/b.ts\n" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/dup",
      projectRoot,
    });

    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.headRefName).toBe("feature/dup");
  });

  it("respects a custom baseBranch", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "develop", "feature/dev"], stdout: "devbase\n" },
      { command: "git", args: ["diff", "--name-only", "devbase...feature/dev"], stdout: "src/dev.ts\n" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/dev",
      projectRoot,
      baseBranch: "develop",
    });

    expect(result.baseBranch).toBe("develop");
    expect(result.headRefName).toBe("feature/dev");
    expect(result.files).toEqual(["src/dev.ts"]);
  });
});
