# AGENTS.md - AI Agent Guidelines for opencode-codebase-index

**Generated:** 2026-01-16 | **Commit:** d02b915 | **Branch:** main

Semantic codebase indexing plugin for OpenCode. Hybrid TypeScript/Rust architecture:
- **TypeScript** (`src/`): Plugin logic, embedding providers, OpenCode tools
- **Rust** (`native/`): Tree-sitter parsing, usearch vectors, SQLite storage, BM25 inverted index

## Build/Test/Lint

```bash
npm run build          # Build TS + Rust native module
npm run build:ts       # TypeScript only (tsup)
npm run build:native   # Rust only (cargo + napi)

npm run test:run       # All tests once
npm test               # Watch mode

npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
```

### Single Test
```bash
npx vitest run tests/files.test.ts
npx vitest run -t "parseFile"
```

### Native Module (requires Rust)
```bash
cd native && cargo build --release && napi build --release --platform
```

## File Structure

```
src/
├── index.ts              # Plugin entry: exports tools + slash commands
├── config/               # Config schema (Zod) + parsing
├── embeddings/           # Provider detection (auto/github/openai/google/ollama)
├── indexer/              # Core: Indexer class, delta tracking
├── git/                  # Branch detection from .git/HEAD
├── tools/                # OpenCode tool definitions (codebase_search, index_*)
├── utils/                # File collection, cost estimation, helpers
├── native/               # TS wrapper for Rust bindings
└── watcher/              # Chokidar file + git branch watcher

native/src/
├── lib.rs                # NAPI exports: parse_file, VectorStore, Database, InvertedIndex
├── parser.rs             # Tree-sitter parsing (TS, JS, Python, Rust, Go, JSON)
├── chunker.rs            # Semantic chunking with overlap
├── store.rs              # usearch vector store (F16 quantization)
├── db.rs                 # SQLite: embeddings, chunks, branch catalog
├── inverted_index.rs     # BM25 keyword search
├── hasher.rs             # xxhash content hashing
└── types.rs              # Shared types

tests/                    # Vitest tests (30s timeout for native ops)
commands/                 # Slash command definitions (/search, /find, /index)
skill/                    # OpenCode skill guidance
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add embedding provider | `src/embeddings/detector.ts` + `provider.ts` |
| Modify indexing logic | `src/indexer/index.ts` (Indexer class) |
| Add OpenCode tool | `src/tools/index.ts` |
| Change parsing behavior | `native/src/parser.rs` |
| Modify vector storage | `native/src/store.rs` |
| Add database operation | `native/src/db.rs` + expose in `lib.rs` |
| Add slash command | `commands/` + register in `src/index.ts` config() |

## CODE MAP

### TypeScript Exports (`src/index.ts`)
| Symbol | Type | Purpose |
|--------|------|---------|
| `default` | Plugin | Main entry: returns tools + config callback |
| `codebase_search` | Tool | Semantic search by meaning |
| `index_codebase` | Tool | Trigger indexing (force/estimate/verbose) |
| `index_status` | Tool | Check index health |
| `index_health_check` | Tool | GC orphaned embeddings/chunks |

### Rust NAPI Exports (`native/src/lib.rs`)
| Symbol | Type | Purpose |
|--------|------|---------|
| `parse_file` | fn | Parse single file → CodeChunk[] |
| `parse_files` | fn | Parallel multi-file parsing |
| `hash_content` | fn | xxhash string |
| `hash_file` | fn | xxhash file contents |
| `VectorStore` | class | usearch wrapper (add/search/save/load) |
| `Database` | class | SQLite: embeddings, chunks, branches, metadata |
| `InvertedIndex` | class | BM25 keyword search |

## CONVENTIONS

### Import Rules (CRITICAL - causes runtime errors if wrong)
```typescript
// CORRECT: .js extension required for ESM
import { Indexer } from "./indexer/index.js";

// WRONG: runtime error
import { Indexer } from "./indexer/index";

// Node.js built-ins: namespace imports
import * as path from "path";
import * as os from "os";
```

### Import Order
1. Type-only imports (`import type { ... }`)
2. External packages + Node.js built-ins
3. Internal modules (with .js extension)

### Naming
| Element | Convention | Example |
|---------|------------|---------|
| Files/Dirs | kebab-case | `codebase-index.json` |
| Functions/Vars | camelCase | `loadJsonFile` |
| Classes/Types | PascalCase | `Indexer`, `ChunkType` |
| OpenCode tools | snake_case | `codebase_search` |
| Constants | UPPER_SNAKE_CASE | `MAX_BATCH_TOKENS` |

### Type Patterns
- Explicit return types on exported functions
- `strict: true` enabled
- Prefix unused params with `_` (ESLint enforced)
- Error handling: use `unknown`, then narrow

```typescript
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
```

### OpenCode Tool Definitions
```typescript
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
const z = tool.schema;  // Use this, not direct zod import

export const my_tool: ToolDefinition = tool({
  description: "Clear description",
  args: {
    query: z.string().describe("Argument purpose"),
    limit: z.number().optional().default(10),
  },
  async execute(args) {
    return "Result string";
  },
});
```

## ANTI-PATTERNS

| Forbidden | Why |
|-----------|-----|
| Missing `.js` in imports | Runtime ESM resolution failure |
| Direct zod import for tools | Use `tool.schema` from plugin package |
| `as any`, `@ts-ignore` | Strict mode violations |
| Empty catch blocks | Hide errors; use `catch { /* ignore */ }` with comment |
| Forgetting `npm run build:native` | Native module won't reflect Rust changes |

## TESTING

- **Framework**: Vitest with globals enabled
- **Timeout**: 30s (native ops can be slow)
- **Location**: `tests/*.test.ts`

### Temp Directory Pattern
```typescript
let tempDir: string;
beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-")); });
afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });
```

### Test Categories
| File | Tests |
|------|-------|
| `native.test.ts` | Rust bindings: parsing, vectors, hashing |
| `database.test.ts` | SQLite: CRUD, branches, GC |
| `inverted-index.test.ts` | BM25 keyword search |
| `files.test.ts` | File collection, .gitignore |
| `cost.test.ts` | Token estimation |

## CONFIGURATION

Config loaded from `.opencode/codebase-index.json` or `~/.config/opencode/codebase-index.json`.

Key options:
- `embeddingProvider`: `auto` | `github-copilot` | `openai` | `google` | `ollama`
- `indexing.watchFiles`: Auto-reindex on file changes
- `indexing.semanticOnly`: Skip generic blocks, only index functions/classes
- `search.hybridWeight`: 0.0 (semantic) to 1.0 (keyword)

## PR CHECKLIST

```bash
npm run build && npm run typecheck && npm run lint && npm run test:run
```
