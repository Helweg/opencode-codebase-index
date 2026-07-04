import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, relative, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(root, "dist/cli.js");
const binDir = resolve(root, "node_modules/.bin");
const binPath = resolve(binDir, "opencode-codebase-index-mcp");

if (!existsSync(cliPath)) {
  console.error("dist/cli.js is missing. Run `npm run build:ts` first.");
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
rmSync(binPath, { force: true });
rmSync(`${binPath}.cmd`, { force: true });

if (process.platform === "win32") {
  writeFileSync(`${binPath}.cmd`, `@echo off\r\nnode "%~dp0\\..\\..\\dist\\cli.js" %*\r\n`, "utf-8");
} else {
  symlinkSync(relative(dirname(binPath), cliPath), binPath);
}

console.log(`Linked ${binPath} -> ${cliPath}`);
