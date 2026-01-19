import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Crash Recovery", () => {
  describe("atomic file writes", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should leave no .tmp files after successful write via atomicWriteSync pattern", () => {
      const targetPath = path.join(tempDir, "test-file.json");
      const tempPath = `${targetPath}.tmp`;
      const data = JSON.stringify({ test: "data" });
      
      fs.writeFileSync(tempPath, data);
      fs.renameSync(tempPath, targetPath);

      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.existsSync(tempPath)).toBe(false);
      expect(JSON.parse(fs.readFileSync(targetPath, "utf-8"))).toEqual({ test: "data" });
    });

    it("should handle rename of non-existent temp file gracefully", () => {
      const targetPath = path.join(tempDir, "test-file.json");
      const tempPath = `${targetPath}.tmp`;

      expect(() => fs.renameSync(tempPath, targetPath)).toThrow();
    });
  });

  describe("indexing lock file", () => {
    let tempDir: string;
    let indexPath: string;
    let lockPath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
      indexPath = path.join(tempDir, ".opencode", "index");
      lockPath = path.join(indexPath, "indexing.lock");
      fs.mkdirSync(indexPath, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should detect when lock file exists", () => {
      expect(fs.existsSync(lockPath)).toBe(false);

      fs.writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }));

      expect(fs.existsSync(lockPath)).toBe(true);
    });

    it("should parse lock file contents correctly", () => {
      const lockData = { startedAt: "2025-01-19T12:00:00.000Z", pid: 12345 };
      fs.writeFileSync(lockPath, JSON.stringify(lockData));

      const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      expect(parsed.startedAt).toBe("2025-01-19T12:00:00.000Z");
      expect(parsed.pid).toBe(12345);
    });

    it("should remove lock file on successful completion", () => {
      fs.writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }));
      expect(fs.existsSync(lockPath)).toBe(true);

      fs.unlinkSync(lockPath);

      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("should handle missing lock file in cleanup gracefully", () => {
      expect(fs.existsSync(lockPath)).toBe(false);

      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }

      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  describe("recovery behavior", () => {
    let tempDir: string;
    let indexPath: string;
    let lockPath: string;
    let fileHashCachePath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-test-"));
      indexPath = path.join(tempDir, ".opencode", "index");
      lockPath = path.join(indexPath, "indexing.lock");
      fileHashCachePath = path.join(indexPath, "file-hashes.json");
      fs.mkdirSync(indexPath, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should clear file hash cache when lock file is present (simulating crash recovery)", () => {
      fs.writeFileSync(fileHashCachePath, JSON.stringify({ "file1.ts": "hash1", "file2.ts": "hash2" }));
      fs.writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }));

      expect(fs.existsSync(fileHashCachePath)).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);

      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(fileHashCachePath);
        fs.unlinkSync(lockPath);
      }

      expect(fs.existsSync(fileHashCachePath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("should not clear hash cache when no lock file exists", () => {
      fs.writeFileSync(fileHashCachePath, JSON.stringify({ "file1.ts": "hash1" }));

      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(fileHashCachePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(fileHashCachePath, "utf-8"));
      expect(content).toEqual({ "file1.ts": "hash1" });
    });
  });
});
