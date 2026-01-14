import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { collectFiles, createIgnoreFilter, shouldIncludeFile } from "../src/utils/files.js";

describe("files utilities", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createIgnoreFilter", () => {
    it("should ignore node_modules by default", () => {
      const filter = createIgnoreFilter(tempDir);

      expect(filter.ignores("node_modules/package/index.js")).toBe(true);
      expect(filter.ignores("src/index.ts")).toBe(false);
    });

    it("should read .gitignore file", () => {
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "*.log\nbuild/\n");
      const filter = createIgnoreFilter(tempDir);

      expect(filter.ignores("debug.log")).toBe(true);
      expect(filter.ignores("build/output.js")).toBe(true);
      expect(filter.ignores("src/main.ts")).toBe(false);
    });
  });

  describe("shouldIncludeFile", () => {
    it("should include files matching include patterns", () => {
      const filter = createIgnoreFilter(tempDir);
      const includePatterns = ["**/*.ts", "**/*.js"];
      const excludePatterns = ["**/node_modules/**"];

      expect(
        shouldIncludeFile(
          path.join(tempDir, "src/index.ts"),
          tempDir,
          includePatterns,
          excludePatterns,
          filter
        )
      ).toBe(true);
    });

    it("should exclude files matching exclude patterns", () => {
      const filter = createIgnoreFilter(tempDir);
      const includePatterns = ["**/*.ts"];
      const excludePatterns = ["**/*.test.ts"];

      expect(
        shouldIncludeFile(
          path.join(tempDir, "src/index.test.ts"),
          tempDir,
          includePatterns,
          excludePatterns,
          filter
        )
      ).toBe(false);
    });

    it("should respect gitignore", () => {
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "ignored/\n");
      const filter = createIgnoreFilter(tempDir);
      const includePatterns = ["**/*.ts"];
      const excludePatterns: string[] = [];

      expect(
        shouldIncludeFile(
          path.join(tempDir, "ignored/file.ts"),
          tempDir,
          includePatterns,
          excludePatterns,
          filter
        )
      ).toBe(false);
    });
  });

  describe("collectFiles", () => {
    it("should collect matching files", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/index.ts"), "export const x = 1;");
      fs.writeFileSync(path.join(tempDir, "src/util.ts"), "export const y = 2;");
      fs.writeFileSync(path.join(tempDir, "readme.md"), "# README");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        [],
        1048576
      );

      expect(result.files.length).toBe(2);
      expect(result.files.some((f) => f.path.endsWith("index.ts"))).toBe(true);
      expect(result.files.some((f) => f.path.endsWith("util.ts"))).toBe(true);
    });

    it("should skip files exceeding max size", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/small.ts"), "x");
      fs.writeFileSync(path.join(tempDir, "src/large.ts"), "x".repeat(1000));

      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        [],
        500
      );

      expect(result.files.length).toBe(1);
      expect(result.files[0].path.endsWith("small.ts")).toBe(true);
      expect(result.skipped.some((s) => s.reason === "too_large")).toBe(true);
    });

    it("should handle empty directory", async () => {
      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        [],
        1048576
      );

      expect(result.files.length).toBe(0);
      expect(result.skipped.length).toBe(0);
    });

    it("should handle multiple include patterns", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/index.ts"), "ts");
      fs.writeFileSync(path.join(tempDir, "src/util.js"), "js");
      fs.writeFileSync(path.join(tempDir, "src/style.css"), "css");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts", "**/*.js"],
        [],
        1048576
      );

      expect(result.files.length).toBe(2);
      expect(result.files.some((f) => f.path.endsWith(".css"))).toBe(false);
    });
  });
});
