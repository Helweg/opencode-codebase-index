import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  bundle: true,
  noExternal: [/.*/],
  external: [
    "zod"
  ],
  esbuildOptions(options) {
    options.banner = {
      js: "// opencode-codebase-index - Semantic codebase search for OpenCode",
    };
  },
});
