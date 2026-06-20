import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface ChangedFilesResult {
  files: string[];
  baseBranch: string;
  source: "gh" | "git";
}

export interface GetChangedFilesOptions {
  pr?: number;
  branch?: string;
  projectRoot: string;
  baseBranch?: string;
}

interface GhPrViewResponse {
  headRefName?: string;
  baseRefName?: string;
  files?: Array<{ path: string }>;
}

export async function getChangedFiles(
  opts: GetChangedFilesOptions,
): Promise<ChangedFilesResult> {
  const { pr, branch, projectRoot, baseBranch = "main" } = opts;

  if (pr !== undefined) {
    return getChangedFilesForPr(pr, projectRoot, baseBranch);
  }

  return getChangedFilesForBranch(branch, projectRoot, baseBranch);
}

async function getChangedFilesForPr(
  pr: number,
  projectRoot: string,
  baseBranch: string,
): Promise<ChangedFilesResult> {
  let headRefName: string | undefined;
  let actualBaseBranch = baseBranch;

  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(pr), "--json", "headRefName,baseRefName,files"],
      { cwd: projectRoot, timeout: 30000 },
    );

    const data = JSON.parse(stdout) as GhPrViewResponse;
    headRefName = data.headRefName;
    actualBaseBranch = data.baseRefName || baseBranch;

    if (data.files && data.files.length > 0) {
      return {
        files: normalizeFiles(
          data.files.map((f) => f.path),
          projectRoot,
        ),
        baseBranch: actualBaseBranch,
        source: "gh",
      };
    }
  } catch (error) {
    throw new Error(
      `Failed to retrieve PR #${pr} via gh CLI: ${getErrorMessage(error)}`,
    );
  }

  if (headRefName === undefined) {
    throw new Error(
      `PR #${pr} returned no usable branch or file information.`,
    );
  }

  return getChangedFilesForBranch(headRefName, projectRoot, actualBaseBranch);
}

async function getChangedFilesForBranch(
  branch: string | undefined,
  projectRoot: string,
  baseBranch: string,
): Promise<ChangedFilesResult> {
  const targetBranch = branch || (await getCurrentBranch(projectRoot));
  const mergeBase = await getMergeBase(projectRoot, baseBranch, targetBranch);

  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", `${mergeBase}...${targetBranch}`],
    { cwd: projectRoot, timeout: 30000 },
  );

  return {
    files: normalizeFiles(stdout.split("\n"), projectRoot),
    baseBranch,
    source: "git",
  };
}

async function getCurrentBranch(projectRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["branch", "--show-current"],
    { cwd: projectRoot, timeout: 30000 },
  );
  return stdout.trim();
}

async function getMergeBase(
  projectRoot: string,
  baseBranch: string,
  branch: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["merge-base", baseBranch, branch],
    { cwd: projectRoot, timeout: 30000 },
  );
  return stdout.trim();
}

function normalizeFiles(rawFiles: string[], projectRoot: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawFiles) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const absolute = path.resolve(projectRoot, trimmed);
    const relative = path.relative(projectRoot, absolute);
    const cleaned = relative.startsWith("./")
      ? relative.slice(2)
      : relative;

    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }

  return result;
}
