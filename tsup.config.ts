import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    "@opencode-ai/plugin",
    "./codebase-index-native.node"
  ],
  esbuildOptions(options) {
    options.banner = {
      js: "// opencode-codebase-index - Semantic codebase search for OpenCode",
    };
  },
});
