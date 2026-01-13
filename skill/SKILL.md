# Codebase Search Skill

Semantic search for finding code by meaning, not just keywords.

## Available Tools

### `codebase_search`
Find code by describing what it does in natural language.

**When to use:**
- Looking for implementations: "find the user authentication logic"
- Finding patterns: "code that handles database connections"
- Locating features: "where is the payment processing"
- Understanding architecture: "find all API route handlers"

**Parameters:**
- `query` (required): Natural language description of what you're looking for
- `limit` (optional): Maximum results (default: 10)

**Example:**
```json
{
  "query": "error handling middleware for HTTP requests",
  "limit": 5
}
```

### `index_codebase`
Create or update the semantic index.

**When to use:**
- Before first search in a new codebase
- After significant code changes
- When search results seem stale

**Parameters:**
- `force` (optional): Reindex from scratch (default: false)
- `estimateOnly` (optional): Show cost estimate without indexing

### `index_status`
Check if the codebase is indexed and ready for search.

**When to use:**
- Before searching to verify index exists
- To see embedding provider configuration
- To check index size

## Usage Strategy

1. **Check status first**: Run `index_status` to see if indexing is needed
2. **Index if needed**: Run `index_codebase` if not indexed
3. **Search semantically**: Use `codebase_search` with descriptive queries

## Query Writing Tips

**Good queries describe behavior:**
- "function that validates email addresses"
- "code that sends notifications to users"
- "error handling for database operations"

**Avoid keyword-only queries:**
- "validateEmail" - use grep instead
- "class User" - use file search instead

## When to Use vs Other Tools

| Need | Tool |
|------|------|
| Find by exact name | `grep`, file search |
| Find by meaning/behavior | `codebase_search` |
| Find definition | LSP goto definition |
| Find all usages | LSP find references |
