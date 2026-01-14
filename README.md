# opencode-codebase-index

Semantic codebase indexing and search for OpenCode. Find code by meaning, not just keywords.

## When to Use

| Scenario | Tool | Why |
|----------|------|-----|
| Don't know function/class names | `codebase_search` | Natural language → code |
| Exploring unfamiliar codebase | `codebase_search` | Finds related code by meaning |
| Know exact identifier | `grep` | Faster, finds all occurrences |
| Need ALL matches | `grep` | Semantic returns top N only |

**Best workflow:** Semantic search for discovery → grep for precision.

## Installation

```bash
npm install opencode-codebase-index
```

Add to your `opencode.json`:

```json
{
  "plugins": ["opencode-codebase-index"]
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

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `force` | boolean | false | Reindex from scratch |
| `estimateOnly` | boolean | false | Show cost estimate only |

### `index_status`

Check if the codebase is indexed and ready for search.

### `index_health_check`

Remove stale entries from deleted files.

## Configuration

Optional configuration in `.opencode/codebase-index.json`:

```json
{
  "embeddingProvider": "auto",
  "scope": "project",
  "indexing": {
    "watchFiles": true,
    "maxFileSize": 1048576
  },
  "search": {
    "maxResults": 20,
    "minScore": 0.1
  }
}
```

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
```

## License

MIT
