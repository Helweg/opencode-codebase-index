# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-02-23

### Added
- **MCP server**: Standalone MCP server (`opencode-codebase-index-mcp` CLI) exposing all 8 tools and 4 prompts over stdio transport, enabling integration with Cursor, Claude Code, and Windsurf
- **Crash-safe indexing**: Lock file and atomic writes prevent index corruption from interrupted indexing sessions, with automatic recovery on next run
- **Git worktree support**: Branch detection now works correctly in git worktrees by resolving `.git` file pointers to the actual git directory
- **Index metadata contract**: Stores embedding provider, model, and dimensions in the database; blocks searches against incompatible indexes with clear error messages and `force=true` rebuild instructions
- **Google `gemini-embedding-001` model**: Support for Google's latest embedding model with Matryoshka truncation (3072D → 1536D) and task-specific embeddings (`CODE_RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`)
- **Google batch embedding**: Batch requests up to 20 texts per API call via `batchEmbedContents` endpoint
- **Compatibility warnings**: Provider mismatch (same model + dimensions) now logs a warning instead of forcing a rebuild
- **Windows support**: Native binaries now build on Windows MSVC across all 5 platform targets (macOS x86/ARM, Linux x86/ARM, Windows x86)

### Changed
- **Embedding API split**: `embed()` replaced by `embedQuery()` and `embedDocument()` to support task-specific embeddings (Google)
- **Type-safe embedding models**: `EMBEDDING_MODELS` constant as single source of truth; `EmbeddingProvider`, `EmbeddingModelName`, and related types derived at compile time
- **Google default model**: Updated from deprecated `text-embedding-004` to `text-embedding-005`
- **Tool formatting**: Extracted all formatting functions from `src/tools/index.ts` to `src/tools/utils.ts`
- **Exhaustive provider check**: `createEmbeddingProvider` uses `never` exhaustive check instead of default branch
- **ESM compatibility**: Build config adds `createRequire` shim for ESM entry points

### Fixed
- **SQLite bind parameter limit**: `get_missing_embeddings` and `get_embeddings_batch` now batch `IN (...)` queries to stay under `SQLITE_MAX_VARIABLE_NUMBER` (999) — fixes crash on large codebases (thanks @zb1749)
- **Google embedding API endpoints**: Corrected single and batch request URLs
- **Index compatibility on force rebuild**: `clearIndex()` now deletes stale index metadata so provider changes take effect
- **Search/findSimilar initialization**: Both now call `ensureInitialized()` before compatibility check
- **Windows MSVC build**: Disabled usearch `simsimd` feature on Windows — MSVC lacks `_mm512_reduce_add_ph` intrinsic. Pinned usearch to 2.23.0 to avoid 2.24.0 `MAP_FAILED` regression. Committed `Cargo.lock` for reproducible CI builds.

## [0.4.1] - 2025-01-19

### Added
- **`requireProjectMarker` config option**: Prevents plugin from hanging when opened in non-project directories like home. When `true` (default), requires a project marker (`.git`, `package.json`, `Cargo.toml`, etc.) to enable file watching and auto-indexing.

### Fixed
- Plugin no longer hangs when OpenCode is opened in home directory or other large non-project directories

## [0.4.0] - 2025-01-18

### Added
- **`find_similar` tool**: Find code similar to a given snippet for duplicate detection, pattern discovery, and refactoring prep. Paste code and find semantically similar implementations elsewhere in the codebase.
- **`codebase_peek` tool**: Token-efficient semantic search returning metadata only (file, line, name, type) without code content. Saves ~90% tokens compared to `codebase_search` for discovery workflows.

## [0.3.2] - 2025-01-18

### Fixed
- Rust code formatting (cargo fmt)
- CI publish workflow: use Node 24 + npm OIDC trusted publishing (no token required)

## [0.3.1] - 2025-01-18

### Added
- **Query embedding cache**: LRU cache (100 entries, 5min TTL) avoids redundant API calls for repeated searches
- **Query similarity matching**: Reuses cached embeddings for similar queries (Jaccard similarity ≥0.85)
- **Batch metadata lookup**: `VectorStore.getMetadata()` and `getMetadataBatch()` for efficient chunk retrieval
- **Parse timing metrics**: Tracks `parseMs` for tree-sitter parsing duration
- **Query cache stats**: Separate tracking for exact hits, similar hits, and misses

### Changed
- BM25 keyword search now uses `getMetadataBatch()` - O(n) instead of O(total) for result metadata lookup

### Fixed
- Remove console output from Logger (was leaking to stdout)
- Record embedding API metrics for search queries (previously only tracked during indexing)
- Record embedding API metrics during batch retries

## [0.3.0] - 2025-01-16

### Added
- **Language support**: Java, C#, Ruby, Bash, C, and C++ parsing via tree-sitter
- **CI improvements**: Rust caching, `cargo fmt --check`, `cargo clippy`, and `cargo test` in workflows
- **/status command**: Check index health and provider info
- **Batch operations**: High-performance bulk inserts for embeddings and chunks (~10-18x speedup)
- **Auto garbage collection**: Configurable automatic cleanup of orphaned embeddings/chunks
- **Documentation**: ARCHITECTURE.md, TROUBLESHOOTING.md, comprehensive AGENTS.md

### Changed
- Upgraded tree-sitter from 0.20 to 0.24 (new LANGUAGE constant API)
- Optimized `embedBatch` for Google and Ollama providers with Promise.all
- Enhanced skill documentation with filter examples

### Fixed
- Node version consistency in publish workflow (Node 24 → Node 22)
- Clippy warnings in Rust code

## [0.2.1] - 2025-01-10

### Fixed
- Rate limit handling and error messages
- TypeScript errors in delta.ts

## [0.2.0] - 2025-01-09

### Added
- **Branch-aware indexing**: Embeddings stored by content hash, branch catalog tracks membership
- **SQLite storage**: Persistent storage for embeddings, chunks, and branch catalog
- **Slash commands**: `/search`, `/find`, `/index`, `/status` registered via config hook
- **Global config support**: `~/.config/opencode/codebase-index.json`
- **Provider-specific rate limiting**: Ollama has no limits, GitHub Copilot has strict limits

### Changed
- Migrated from JSON file storage to SQLite database
- Improved rate limit handling for GitHub Models API (15 req/min)

## [0.1.11] - 2025-01-07

### Added
- Community standards: LICENSE, Code of Conduct, Contributing guide, Security policy, Issue templates

### Fixed
- Clippy warnings and TypeScript type errors

## [0.1.10] - 2025-01-06

### Added
- **F16 quantization**: 50% memory reduction for vector storage
- **Dead-letter queue**: Failed embedding batches are tracked for retry
- **JSDoc/docstring extraction**: Comments included with semantic nodes
- **Overlapping chunks**: Improved context continuity across chunk boundaries
- **maxChunksPerFile config**: Control token costs for large files
- **semanticOnly config**: Only index functions/classes, skip generic blocks

### Changed
- Moved inverted index from TypeScript to Rust native module (performance improvement)

### Fixed
- GitHub Models API for embeddings instead of Copilot API

## [0.1.9] - 2025-01-05

### Fixed
- Use GitHub Models API for embeddings instead of Copilot API

## [0.1.8] - 2025-01-04

### Fixed
- Only export default plugin to prevent OpenCode loader crash
- Downgrade to zod v3 to match OpenCode SDK version

## [0.1.3] - 2025-01-02

### Changed
- Use Node.js 24 for npm 11+ trusted publishing support
- Externalize @opencode-ai/plugin to prevent runtime conflicts

### Fixed
- ESM output as main entry for Bun/OpenCode compatibility
- Native binding loading in CJS context

## [0.1.1] - 2025-01-01

### Added
- CI/CD workflows for testing and publishing
- Comprehensive README with badges, diagrams, and examples

### Fixed
- NAPI configuration for OIDC trusted publishing

## [0.1.0] - 2024-12-30

### Added
- **Initial release**
- Semantic codebase indexing with tree-sitter parsing
- Vector similarity search with usearch (HNSW algorithm)
- Hybrid search combining semantic + BM25 keyword matching
- Support for TypeScript, JavaScript, Python, Rust, Go, JSON
- Multiple embedding providers: GitHub Copilot, OpenAI, Google, Ollama
- Incremental indexing with file hash caching
- File watcher for automatic re-indexing
- OpenCode tools: `codebase_search`, `index_codebase`, `index_status`, `index_health_check`

[0.5.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/Helweg/opencode-codebase-index/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.11...v0.2.0
[0.1.11]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.3...v0.1.8
[0.1.3]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Helweg/opencode-codebase-index/releases/tag/v0.1.0
