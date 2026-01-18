---
name: codebase-search
description: Semantic code search by meaning. Use codebase_peek to find WHERE code is (saves tokens), codebase_search to see actual code. For exact identifiers, use grep instead.
---

# Codebase Search Skill

## When to Use What

| Scenario | Tool | Why |
|----------|------|-----|
| Just need file locations | `codebase_peek` | Metadata only, saves ~90% tokens |
| Need to see actual code | `codebase_search` | Returns full code content |
| Find duplicates/patterns | `find_similar` | Given code snippet → similar code |
| Don't know function/class names | `codebase_peek` or `codebase_search` | Natural language → code |
| Know exact identifier names | `grep` | Faster, more precise |
| Need ALL occurrences | `grep` | Semantic returns top N only |

## Recommended Workflow

1. **Locate with peek**: `codebase_peek("authentication flow")` → get file locations
2. **Read what matters**: `Read` the specific files you need
3. **Drill down with grep**: `grep "validateToken"` for exact matches

## Tools

### `codebase_peek`
Find WHERE code is. Returns metadata only (file, line, name, type).

```
codebase_peek(query="validation logic", chunkType="function", directory="src/utils")
```

### `codebase_search`
Find code with full content. Use when you need to see implementation.

```
codebase_search(query="error handling middleware", fileType="ts", contextLines=2)
```

### `find_similar`
Find code similar to a given snippet. Use for duplicate detection, pattern discovery, refactoring.

```
find_similar(code="function validate(input) { return input.length > 0; }", excludeFile="src/current.ts")
```

### `index_codebase`
Create/update index. Required before first search. Incremental (~50ms when unchanged).

### `index_status`
Check if indexed and ready.

## Query Tips

**Describe behavior, not syntax:**
- Good: `"function that hashes passwords securely"`
- Bad: `"hashPassword"` (use grep for exact names)

## Filters

| Filter | Example |
|--------|---------|
| `chunkType` | `function`, `class`, `interface`, `type`, `method` |
| `directory` | `"src/api"`, `"tests"` |
| `fileType` | `"ts"`, `"py"`, `"rs"` |
