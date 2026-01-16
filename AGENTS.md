# AGENTS.md - AI Agent Guidelines for opencode-codebase-index

Semantic codebase indexing plugin for OpenCode. Hybrid TypeScript/Rust architecture:
- **TypeScript** (`src/`): Plugin logic, embedding providers, tools
- **Rust** (`native/`): Tree-sitter parsing, vector search (usearch), SQLite storage

## Build/Test/Lint Commands

```bash
npm run build          # Build both TypeScript and Rust native module
npm run build:ts       # Build TypeScript only (via tsup)
npm run build:native   # Build Rust native module only

npm run test:run       # Run all tests once (CI mode)
npm test               # Run tests in watch mode

npm run lint           # ESLint on src/
npm run typecheck      # TypeScript type checking (tsc --noEmit)
```

### Running a Single Test

```bash
npx vitest run tests/files.test.ts           # Run specific test file
npx vitest run -t "parseFile"                # Run tests matching pattern
npx vitest run tests/native.test.ts --reporter=verbose
```

### Native Module Build (requires Rust)

```bash
cd native && cargo build --release && napi build --release --platform
```

## Code Style Guidelines

### Import Organization

Group imports in this order, separated by blank lines:
1. Type-only imports (`import type { ... }`)
2. External packages and Node.js built-ins
3. Internal modules

**Always use `.js` extension** for internal imports (ESM requirement):
```typescript
import { Indexer } from "./indexer/index.js";  // Correct
import { Indexer } from "./indexer/index";     // Wrong - runtime error
```

**Use namespace imports** for Node.js built-ins:
```typescript
import * as path from "path";
import * as os from "os";
```

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Files/Directories | kebab-case | `codebase-index.json`, `native/` |
| Functions/Variables | camelCase | `loadJsonFile`, `projectRoot` |
| Classes/Types/Interfaces | PascalCase | `Indexer`, `ChunkType` |
| OpenCode tools | snake_case | `codebase_search`, `index_codebase` |
| Constants | UPPER_SNAKE_CASE | `MAX_BATCH_TOKENS` |

### Type Patterns

- **Explicit return types** on all exported functions
- **Strict TypeScript** enabled (`strict: true`)
- **Prefix unused parameters** with `_` (ESLint enforced)
- **Use `unknown`** for error handling, then narrow:

```typescript
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
```

### Error Handling

```typescript
// Non-critical: empty catch
try {
  return JSON.parse(readFileSync(filePath, "utf-8"));
} catch { /* ignore */ }
return null;

// Critical: descriptive error
throw new Error("No embedding provider available. Configure GitHub, OpenAI, Google, or Ollama.");
```

Use `p-retry` for network operations with rate limit handling.

### OpenCode Tool Definitions

```typescript
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
const z = tool.schema;

export const my_tool: ToolDefinition = tool({
  description: "Clear, concise description",
  args: {
    query: z.string().describe("What this argument is for"),
    limit: z.number().optional().default(10),
  },
  async execute(args) {
    return "Result string";
  },
});
```

## File Structure

```
src/
├── index.ts              # Plugin entry point
├── config/               # Configuration schema and parsing
├── embeddings/           # Provider detection and API clients
├── indexer/              # Core indexing logic
├── git/                  # Git utilities (branch detection)
├── tools/                # OpenCode tool definitions
├── utils/                # File collection, cost estimation
├── native/               # Rust native module wrapper
└── watcher/              # File/git change watcher

native/                   # Rust source (tree-sitter, usearch, SQLite)
tests/                    # Vitest test files (.test.ts suffix)
```

## Testing Guidelines

- Use Vitest globals (`describe`, `it`, `expect`, `beforeEach`, `afterEach`)
- Test timeout is 30 seconds (native module operations can be slow)
- Use temp directories for file-based tests:

```typescript
let tempDir: string;
beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-")); });
afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });
```

## Configuration Files

| File | Purpose |
|------|---------|
| `tsconfig.json` | ES2022 target, ESNext modules, strict mode |
| `tsup.config.ts` | ESM + CJS output, external node modules |
| `eslint.config.js` | typescript-eslint recommended rules |
| `vitest.config.ts` | Node environment, 30s timeout |
| `native/Cargo.toml` | Rust dependencies and build config |

## Common Pitfalls

1. **Missing `.js` extension** in imports causes runtime errors
2. **Native module not built**: Run `npm run build:native` after cloning
3. **Type errors with tool schemas**: Use `z` from `tool.schema`, not direct zod import

## PR Checklist

```bash
npm run build && npm run typecheck && npm run lint && npm run test:run
```
