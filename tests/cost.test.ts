import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  formatBytes,
  estimateChunksFromFiles,
} from "../src/utils/cost.js";

describe("cost utilities", () => {
  describe("estimateTokens", () => {
    it("should estimate tokens from text length", () => {
      const text = "a".repeat(100);
      const tokens = estimateTokens(text);

      expect(tokens).toBe(25);
    });

    it("should round up for partial tokens", () => {
      const text = "a".repeat(101);
      const tokens = estimateTokens(text);

      expect(tokens).toBe(26);
    });

    it("should handle empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });
  });

  describe("formatBytes", () => {
    it("should format bytes correctly", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(100)).toBe("100 B");
      expect(formatBytes(1024)).toBe("1 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1048576)).toBe("1 MB");
      expect(formatBytes(1073741824)).toBe("1 GB");
    });
  });

  describe("estimateChunksFromFiles", () => {
    it("should estimate chunks based on file sizes", () => {
      const files = [
        { path: "a.ts", size: 400 },
        { path: "b.ts", size: 800 },
        { path: "c.ts", size: 1200 },
      ];

      const chunks = estimateChunksFromFiles(files);

      expect(chunks).toBeGreaterThan(0);
      expect(chunks).toBeLessThan(20);
    });

    it("should return at least 1 chunk per file", () => {
      const files = [
        { path: "tiny.ts", size: 10 },
      ];

      const chunks = estimateChunksFromFiles(files);

      expect(chunks).toBeGreaterThanOrEqual(1);
    });

    it("should handle empty file list", () => {
      const chunks = estimateChunksFromFiles([]);

      expect(chunks).toBe(0);
    });
  });
});
