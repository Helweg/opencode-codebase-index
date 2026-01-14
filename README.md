# opencode-codebase-index

Semantic codebase indexing and search for OpenCode. Find code by meaning, not just keywords.

## When to Use

| Scenario                        | Tool                | Why                           |
| ------------------------------- | ------------------- | ----------------------------- |
| Don't know function/class names | `codebase_search` | Natural language → code      |
| Exploring unfamiliar codebase   | `codebase_search` | Finds related code by meaning |
| Know exact identifier           | `grep`            | Faster, finds all occurrences |
| Need ALL matches                | `grep`            | Semantic returns top N only   |

**Best workflow:** Semantic search for discovery → grep for precision.

## Installation

```bash
npm install opencode-codebase-index
```

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-codebase-index"]
}
```

## Tools

### `codebase_search`

Search code by describing what it does. Returns focused results (5-10 files).

```
"find the user authentication logic"
"code that handles database connections"
"error handling middleware for HTTP requests"
```

**Good queries describe behavior:**

- "function that validates email addresses"
- "middleware that checks JWT tokens"
- "error handling for payment failures"

**Use grep instead for:**

- Exact names: `validateEmail`, `UserService`
- Keywords: `TODO`, `FIXME`
- Literals: `401`, `error`

### `index_codebase`

Create or update the semantic index. Incremental indexing is fast (~50ms when nothing changed).

| Parameter        | Type    | Default | Description             |
| ---------------- | ------- | ------- | ----------------------- |
| `force`        | boolean | false   | Reindex from scratch    |
| `estimateOnly` | boolean | false   | Show cost estimate only |

### `index_status`

Check if the codebase is indexed and ready for search.

### `index_health_check`

Remove stale entries from deleted files.

## Slash Commands

Copy the commands from `commands/` to your project's `.opencode/command/` directory:

```bash
cp -r node_modules/opencode-codebase-index/commands/* .opencode/command/
```

Available commands:

| Command             | Description                         |
| ------------------- | ----------------------------------- |
| `/search <query>` | Semantic search for code by meaning |
| `/index`          | Create or update the semantic index |
| `/find <query>`   | Hybrid search (semantic + grep)     |

## Configuration

Optional configuration in `.opencode/codebase-index.json`:

```json
{
  "embeddingProvider": "auto",
  "scope": "project",
  "indexing": {
    "autoIndex": false,
    "watchFiles": true,
    "maxFileSize": 1048576
  },
  "search": {
    "maxResults": 20,
    "minScore": 0.1,
    "hybridWeight": 0.5,
    "contextLines": 0
  }
}
```

| Option                   | Default       | Description                                                      |
| ------------------------ | ------------- | ---------------------------------------------------------------- |
| `embeddingProvider`    | `"auto"`    | `auto`, `github-copilot`, `openai`, `google`, `ollama` |
| `scope`                | `"project"` | `project` (local) or `global` (shared)                       |
| `indexing.autoIndex`   | `false`     | Auto-index on plugin load                                        |
| `indexing.watchFiles`  | `true`      | Watch for file changes and re-index                              |
| `indexing.maxFileSize` | `1048576`   | Max file size in bytes (1MB)                                     |
| `search.maxResults`    | `20`        | Max results to return                                            |
| `search.minScore`      | `0.1`       | Minimum similarity score                                         |
| `search.hybridWeight`  | `0.5`       | Keyword vs semantic balance (0=semantic only, 1=keyword only)    |
| `search.contextLines`  | `0`         | Extra lines to include before/after each match                   |

### Embedding Providers

Uses OpenCode's authentication. Auto-detected in order:

1. **GitHub Copilot** - Uses Copilot API
2. **OpenAI** - Uses OpenAI API
3. **Google** - Uses Gemini API
4. **Ollama** - Local, requires `nomic-embed-text` or similar

## How It Works

1. **Parsing** - Tree-sitter extracts semantic chunks (functions, classes, etc.)
2. **Embedding** - Chunks converted to vectors via embedding API
3. **Storage** - Vectors stored locally using usearch
4. **Search** - Query embedded and compared via cosine similarity + keyword matching

Index stored in `.opencode/index/` within your project.

## Performance

- **Incremental indexing**: ~50ms when no files changed
- **Full index**: Depends on codebase size (Express.js: ~30s for 472 chunks)
- **Search latency**: ~800-1000ms (embedding API call)
- **Token savings**: 99%+ vs reading all files

## Requirements

- Node.js >= 18
- Rust toolchain (for building native module)

## Building

```bash
npm run build        # Full build (TS + Rust)
npm run build:ts     # TypeScript only
npm run test         # Run tests
npm run typecheck    # TypeScript type checking
```

## Local Development

To test the plugin locally without publishing to npm:

1. Build the plugin:
```bash
npm run build
```

2. Deploy to OpenCode's plugin cache:
```bash
rm -rf ~/.cache/opencode/node_modules/opencode-codebase-index
mkdir -p ~/.cache/opencode/node_modules/opencode-codebase-index
cp -R dist native commands skill package.json ~/.cache/opencode/node_modules/opencode-codebase-index/
```

3. Create a loader in your test project:
```bash
mkdir -p .opencode/plugin
echo 'export { default } from "$HOME/.cache/opencode/node_modules/opencode-codebase-index/dist/index.js"' > .opencode/plugin/codebase-index.ts
```

4. Run `opencode` in your test project.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run the build: `npm run build`
5. Test locally using the steps above
6. Commit your changes: `git commit -m "feat: add my feature"`
7. Push to your fork: `git push origin feature/my-feature`
8. Open a pull request

CI will automatically run tests and type checking on your PR.

### Project Structure

```
├── src/
│   ├── index.ts          # Plugin entry point
│   ├── config/           # Configuration schema
│   ├── embeddings/       # Embedding provider detection and API
│   ├── indexer/          # Core indexing logic
│   ├── tools/            # OpenCode tool definitions
│   ├── utils/            # File collection, cost estimation
│   ├── native/           # Rust native module wrapper
│   └── watcher/          # File change watcher
├── native/
│   └── src/              # Rust native module (tree-sitter, usearch)
├── tests/                # Unit tests (vitest)
├── commands/             # Slash command definitions
├── skill/                # Agent skill guidance
└── .github/workflows/    # CI/CD (test, build, publish)
```

### Native Module

The Rust native module handles:
- Tree-sitter parsing for semantic chunking
- xxHash for fast file hashing
- usearch for vector storage and similarity search

To rebuild the native module:
```bash
npm run build:native
```

Requires Rust toolchain installed.

## License

MIT
