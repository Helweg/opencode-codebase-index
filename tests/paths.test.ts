import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  hasFilteredPathSegment,
  isBuildPathSegment,
  isHiddenPathSegment,
  normalizePathSeparators,
} from "../src/utils/paths.js";

describe("path helpers", () => {
  it("normalizes Windows path separators", () => {
    expect(normalizePathSeparators("src\\indexer\\index.ts")).toBe("src/indexer/index.ts");
  });

  it("detects hidden path segments without flagging dot traversals", () => {
    expect(isHiddenPathSegment(".git")).toBe(true);
    expect(isHiddenPathSegment(".")).toBe(false);
    expect(isHiddenPathSegment("..")).toBe(false);
    expect(isHiddenPathSegment("src")).toBe(false);
  });

  it("detects build path segments", () => {
    expect(isBuildPathSegment("build")).toBe(true);
    expect(isBuildPathSegment("cmake-build-debug")).toBe(true);
    expect(isBuildPathSegment("src")).toBe(false);
  });

  it("detects filtered segments across a relative path", () => {
    expect(hasFilteredPathSegment(`src${path.sep}.git${path.sep}config`)).toBe(true);
    expect(hasFilteredPathSegment(`src${path.sep}cmake-build-debug${path.sep}index.ts`)).toBe(true);
    expect(hasFilteredPathSegment(`src${path.sep}watcher${path.sep}index.ts`)).toBe(false);
  });
});
