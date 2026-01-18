# Codebase Search Skill

Semantic search for finding code by meaning, not just keywords.

## When to Use Semantic Search vs Grep

| Scenario | Use | Why |
|----------|-----|-----|
| Don't know function/class names | `codebase_search` | Natural language → code |
| Concept discovery ("what handles auth?") | `codebase_search` | Finds related code by meaning |
| Know exact identifier names | `grep` | Faster, more precise |
| Need ALL occurrences | `grep` | Semantic returns top N only |
| Unfamiliar codebase exploration | `codebase_search` | Broader conceptual matches |

## Hybrid Strategy (Recommended)

1. **Discover with semantic**: `codebase_search("authentication flow")` → get candidate files
2. **Drill down with grep**: `grep "validateToken"` in those files for exact matches
3. **Use LSP**: For definitions and references once you have the identifier

## Available Tools

### `codebase_search`
Find code by describing what it does in natural language.

**Best for:**
- "find the user authentication logic"
- "code that handles database connections"  
- "error handling middleware for HTTP requests"
- "where is the payment processing"

**Parameters:**
- `query` (required): Natural language description
- `limit` (optional): Maximum results (default: 10)
- `chunkType` (optional): Filter by code type
- `directory` (optional): Filter by directory path
- `fileType` (optional): Filter by file extension
- `contextLines` (optional): Extra lines before/after each match

**Returns:** Focused list of 5-10 most relevant files/chunks with scores.

### `index_codebase`
Create or update the semantic index. Required before first search.

**Parameters:**
- `force` (optional): Reindex from scratch (default: false)
- `estimateOnly` (optional): Show cost estimate without indexing
- `verbose` (optional): Show skipped files and parse failures

**Note:** Incremental indexing is fast (~50ms) when files haven't changed.

### `index_status`
Check if the codebase is indexed and ready for search.

### `index_health_check`
Remove stale entries from deleted files and orphaned embeddings.

### `index_metrics`
Get performance statistics for indexing and search operations.
Requires `debug.enabled` and `debug.metrics` to be `true` in config.

**Shows:** Files indexed, chunks created, cache hit rate, search timing breakdown, GC stats, embedding API call stats.

### `index_logs`
Get recent debug logs with optional filtering.
Requires `debug.enabled` to be `true` in config.

**Parameters:**
- `limit` (optional): Maximum log entries (default: 20)
- `category` (optional): Filter by `search`, `embedding`, `cache`, `gc`, `branch`, `general`
- `level` (optional): Filter by `error`, `warn`, `info`, `debug`

## Search Filters

### Filter by Chunk Type (`chunkType`)

Narrow results to specific code constructs:

| Value | Finds |
|-------|-------|
| `function` | Functions, arrow functions |
| `class` | Class definitions |
| `method` | Class methods |
| `interface` | TypeScript interfaces |
| `type` | Type aliases |
| `enum` | Enumerations |
| `struct` | Rust/Go structs |
| `impl` | Rust impl blocks |
| `trait` | Rust traits |
| `module` | Module definitions |

**Examples:**
```
codebase_search(query="validation logic", chunkType="function")
codebase_search(query="data models", chunkType="interface")
codebase_search(query="user entity", chunkType="class")
```

### Filter by Directory (`directory`)

Scope search to specific paths:

```
codebase_search(query="API routes", directory="src/api")
codebase_search(query="test helpers", directory="tests")
codebase_search(query="database queries", directory="src/db")
```

### Filter by File Type (`fileType`)

Limit to specific languages:

```
codebase_search(query="config parsing", fileType="ts")
codebase_search(query="build scripts", fileType="py")
codebase_search(query="data structures", fileType="rs")
```

### Combining Filters

Filters can be combined for precise results:

```
codebase_search(
  query="validation",
  chunkType="function",
  directory="src/utils",
  fileType="ts"
)
```

## Hybrid Weight Tuning

The `hybridWeight` config option (0.0-1.0) balances semantic vs keyword search:

| Value | Behavior | Best For |
|-------|----------|----------|
| `0.0` | Pure semantic | Conceptual queries, unfamiliar code |
| `0.5` | Balanced (default) | General use |
| `1.0` | Pure keyword (BM25) | When you know specific terms |

Configure in `.opencode/codebase-index.json`:
```json
{
  "search": {
    "hybridWeight": 0.3
  }
}
```

**When to adjust:**
- Lower (0.2-0.4): Exploratory queries, finding related code
- Higher (0.6-0.8): When query contains specific identifiers

## Query Writing Tips

**Describe behavior, not syntax:**
```
Good: "function that hashes passwords securely"
Bad:  "hashPassword" (use grep for exact names)

Good: "middleware that checks JWT tokens"
Bad:  "jwt" (too vague, use grep for keyword)

Good: "error handling for unauthorized requests"  
Bad:  "401" (literal keyword, use grep)
```

## Workflow Examples

### Exploring unfamiliar codebase
```
1. index_status → check if indexed
2. index_codebase → if needed
3. codebase_search("how does authentication work") → get overview
4. codebase_search("session management") → drill into specifics
5. grep "SessionStore" → once you know the class name
```

### Finding all functions in a module
```
1. codebase_search(query="utility helpers", directory="src/utils", chunkType="function")
2. Review results to understand available utilities
3. grep specific function name for all usages
```

### Finding implementation for a feature
```
1. codebase_search("image upload and processing") → find relevant files
2. Read top results to understand structure
3. grep "uploadImage" → find exact function
4. LSP goto_definition → navigate to implementation
```

### Debugging unknown code path
```
1. codebase_search("error handling for payment failures") → find error handlers
2. codebase_search("retry logic for API calls") → find retry mechanisms
3. grep "PaymentError" → find specific error class
```

### Finding TypeScript interfaces
```
1. codebase_search(query="user data", chunkType="interface") → find User interfaces
2. codebase_search(query="API response", chunkType="type") → find response types
```
