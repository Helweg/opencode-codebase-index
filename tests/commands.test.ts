import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadCommandsFromDirectory } from "../src/commands/loader.js";

describe("Command Loader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "commands-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("loadCommandsFromDirectory", () => {
    it("should load command with frontmatter", () => {
      const content = `---
description: Test command description
---

This is the template body.

With multiple lines.`;
      
      fs.writeFileSync(path.join(tempDir, "test.md"), content);

      const commands = loadCommandsFromDirectory(tempDir);

      expect(commands.size).toBe(1);
      expect(commands.has("test")).toBe(true);
      
      const cmd = commands.get("test")!;
      expect(cmd.description).toBe("Test command description");
      expect(cmd.template).toBe("This is the template body.\n\nWith multiple lines.");
    });

    it("should use default description when frontmatter missing", () => {
      const content = `Just a template without frontmatter.`;
      
      fs.writeFileSync(path.join(tempDir, "simple.md"), content);

      const commands = loadCommandsFromDirectory(tempDir);

      expect(commands.size).toBe(1);
      const cmd = commands.get("simple")!;
      expect(cmd.description).toBe("Run the simple command");
      expect(cmd.template).toBe("Just a template without frontmatter.");
    });

    it("should use default description when frontmatter has no description field", () => {
      const content = `---
author: someone
---

Template body here.`;
      
      fs.writeFileSync(path.join(tempDir, "nodesc.md"), content);

      const commands = loadCommandsFromDirectory(tempDir);

      const cmd = commands.get("nodesc")!;
      expect(cmd.description).toBe("Run the nodesc command");
      expect(cmd.template).toBe("Template body here.");
    });

    it("should load multiple command files", () => {
      fs.writeFileSync(path.join(tempDir, "search.md"), `---
description: Search the codebase
---
Search template`);

      fs.writeFileSync(path.join(tempDir, "index.md"), `---
description: Index the codebase
---
Index template`);

      fs.writeFileSync(path.join(tempDir, "find.md"), `---
description: Find code
---
Find template`);

      const commands = loadCommandsFromDirectory(tempDir);

      expect(commands.size).toBe(3);
      expect(commands.has("search")).toBe(true);
      expect(commands.has("index")).toBe(true);
      expect(commands.has("find")).toBe(true);
    });

    it("should only load .md files", () => {
      fs.writeFileSync(path.join(tempDir, "valid.md"), "Valid command");
      fs.writeFileSync(path.join(tempDir, "invalid.txt"), "Not a command");
      fs.writeFileSync(path.join(tempDir, "also-invalid.json"), "{}");

      const commands = loadCommandsFromDirectory(tempDir);

      expect(commands.size).toBe(1);
      expect(commands.has("valid")).toBe(true);
    });

    it("should return empty map for non-existent directory", () => {
      const commands = loadCommandsFromDirectory("/nonexistent/path");

      expect(commands.size).toBe(0);
    });

    it("should return empty map for empty directory", () => {
      const commands = loadCommandsFromDirectory(tempDir);

      expect(commands.size).toBe(0);
    });

    it("should handle empty file", () => {
      fs.writeFileSync(path.join(tempDir, "empty.md"), "");

      const commands = loadCommandsFromDirectory(tempDir);

      expect(commands.size).toBe(1);
      const cmd = commands.get("empty")!;
      expect(cmd.description).toBe("Run the empty command");
      expect(cmd.template).toBe("");
    });

    it("should handle frontmatter with colons in value", () => {
      const content = `---
description: Search codebase: semantic search tool
---

Template body.`;
      
      fs.writeFileSync(path.join(tempDir, "colons.md"), content);

      const commands = loadCommandsFromDirectory(tempDir);

      const cmd = commands.get("colons")!;
      expect(cmd.description).toBe("Search codebase: semantic search tool");
    });

    it("should preserve template formatting", () => {
      const content = `---
description: Test
---

Line 1

- Bullet 1
- Bullet 2

\`\`\`typescript
const x = 1;
\`\`\`

Final line.`;
      
      fs.writeFileSync(path.join(tempDir, "formatted.md"), content);

      const commands = loadCommandsFromDirectory(tempDir);

      const cmd = commands.get("formatted")!;
      expect(cmd.template).toContain("- Bullet 1");
      expect(cmd.template).toContain("```typescript");
      expect(cmd.template).toContain("const x = 1;");
    });
  });

  describe("actual commands directory", () => {
    it("should load real commands from commands/ directory", () => {
      const commandsDir = path.join(__dirname, "..", "commands");
      
      if (!fs.existsSync(commandsDir)) {
        return;
      }

      const commands = loadCommandsFromDirectory(commandsDir);

      expect(commands.size).toBeGreaterThanOrEqual(3);
      expect(commands.has("search")).toBe(true);
      expect(commands.has("index")).toBe(true);
      expect(commands.has("find")).toBe(true);

      const indexCmd = commands.get("index")!;
      expect(indexCmd.description).toBe("Index the codebase for semantic search");
      expect(indexCmd.template).toContain("index_codebase");
    });
  });
});
