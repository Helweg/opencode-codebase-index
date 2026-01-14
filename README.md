# opencode-codebase-index

Semantic codebase indexing and search for OpenCode. Find code by meaning, not just keywords.

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

Search code using natural language queries.

```
"find the user authentication logic"
"code that handles database connections"
"error handling middleware for HTTP requests"
```

### `index_codebase`

Create or update the semantic index. Run before first search.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `force` | boolean | false | Reindex from scratch |
| `estimateOnly` | boolean | false | Show cost estimate only |

### `index_status`

Check if the codebase is indexed and ready for search.

### `index_health_check`

Remove stale entries from deleted files. Run this to clean up the index after files have been deleted.

## Configuration

Optional configuration in `opencode.json`:

```json
{
  "plugins": ["opencode-codebase-index"],
  "codebaseIndex": {
    "embeddingProvider": "auto",
    "scope": "project",
    "indexing": {
      "watchFiles": true,
      "batchSize": 50,
      "maxFileSize": 1048576
    },
    "search": {
      "maxResults": 20,
      "minScore": 0.5
    }
  }
}
```

### Embedding Providers

Uses OpenCode's authentication. Auto-detected in order of priority:

1. **GitHub Copilot** - Uses Copilot API
2. **OpenAI** - Uses OpenAI API
3. **Google** - Uses Gemini API
4. **Ollama** - Local, requires `nomic-embed-text` or similar model

## Requirements

- Node.js >= 18
- Rust toolchain (for building native module)

## Building

```bash
npm run build
```

This compiles both TypeScript and the Rust native module.

## How It Works

1. **Parsing** - Tree-sitter extracts semantic chunks (functions, classes, etc.)
2. **Embedding** - Chunks are converted to vectors via embedding API
3. **Storage** - Vectors stored locally using usearch
4. **Search** - Query embedded and compared via cosine similarity

Index is stored in `.opencode/index/` within your project.

## License

MIT
