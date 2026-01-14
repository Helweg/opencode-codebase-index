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

**Returns:** Focused list of 5-10 most relevant files/chunks with scores.

### `index_codebase`
Create or update the semantic index. Required before first search.

**Parameters:**
- `force` (optional): Reindex from scratch (default: false)
- `estimateOnly` (optional): Show cost estimate without indexing

**Note:** Incremental indexing is fast (~50ms) when files haven't changed.

### `index_status`
Check if the codebase is indexed and ready for search.

### `index_health_check`
Remove stale entries from deleted files.

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
