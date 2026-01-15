import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: false,
  bundle: true,
  noExternal: [
    "chokidar",
    "ignore",
    "p-queue",
    "p-retry",
    "tiktoken",
    "zod",
  ],
  external: [
    "@opencode-ai/plugin",
    /^node:/,
    "fs",
    "fs/promises",
    "path",
    "os",
    "crypto",
    "stream",
    "events",
    "util",
    "buffer",
    "child_process",
    "assert",
    "net",
    "tls",
    "http",
    "https",
    "url",
  ],
  esbuildOptions(options) {
    options.banner = {
      js: "// opencode-codebase-index - Semantic codebase search for OpenCode",
    };
  },
});
