# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-03-29

### Added
- **Custom provider batch caps**: Added `customProvider.maxBatchSize` / `max_batch_size` support so OpenAI-compatible embedding servers can cap inputs per `/embeddings` request
- **Environment placeholders in config**: Added `{env:VAR_NAME}` placeholder support for string config values so secrets and endpoints can be supplied from the environment instead of committed files

### Changed
- **Release documentation alignment**: Updated release metadata to publish the post-`v0.6.0` config improvements as `v0.6.1`

## [0.6.0] - 2026-03-28

### Added
- **Evaluation harness**: First-class eval CLI, golden datasets, budgets, compare mode, run artifacts, and smoke/quality workflows for measuring retrieval quality over time
- **Implementation lookup workflow**: Added a dedicated definition/implementation retrieval path across the CLI, plugin tools, MCP server, indexer, and tests for faster code lookup by intent
- **Cross-repo benchmarking**: Added a benchmark runner with ripgrep and ast-grep baselines plus reproducible benchmarking documentation and golden datasets for external repos
- **Release automation guardrails**: Added Release Drafter automation and CI enforcement for release-category and semver labels on pull requests
- **Contributor language-support guide**: Added an agent-ready guide for extending semantic parsing and call-graph support to new languages
- **PHP language support**: Added semantic parsing, chunking, and call-graph extraction for PHP, including fixtures and tests for constructors, imports, method calls, and simple calls

### Changed
- **Evaluation CI strategy**: Split the default GitHub Models quality gate from explicit external-provider budget checks and documented the active CI budget paths
- **Documentation refresh**: Reorganized contributor and maintenance docs, expanded evaluation and benchmarking guidance, and updated README benchmark snapshots and workflow references

### Fixed
- **Release Drafter permissions**: Restored draft-release updates so release automation can keep draft notes current
- **Eval/CI correctness**: Closed CI gating gaps, normalized baseline paths, and pinned the Rust toolchain action input used by CI
- **Benchmark auditability**: Fixed scoped ast-grep metric accounting and dataset/result mutability issues in the benchmark runner and reporting flow
- **Supply-chain hardening**: Tightened dependency and repository security posture, including stronger git/worktree handling coverage in tests
- **Native test reliability**: `test:run` and `test:coverage` now rebuild the native module first so newly added parser/call-graph language support is exercised against a current binary during release verification

## [0.5.2] - 2026-03-21

### Added
- **Call graph extraction and query**: Tree-sitter query-based extraction of function calls, method calls, constructors, and imports across 5 languages (TypeScript/JavaScript, Python, Go, Rust)
- **`call_graph` tool**: Query callers or callees of any function/method with branch-aware filtering
- **DB schema v2**: `symbols`, `call_edges`, and `branch_symbols` tables with full CRUD, GC, and batch operations
- **Same-file call resolution**: Automatically resolves call edges to symbols defined in the same file during indexing
- **`/call-graph` slash command**: Added command support for call graph workflows

### Changed
- **Documentation updates**: Expanded README, CHANGELOG, and skill guide to document call graph usage and behavior

### Fixed
- **Missing `call_graph` export**: The `call_graph` tool was not exported from the plugin entry point — now available to OpenCode users
- **JavaScript call extraction routing**: JavaScript now uses a dedicated query file instead of TypeScript query routing
- **Caller output context**: Caller results now include caller symbol/file context for clearer navigation
- **Call graph consistency/integrity**: Improved branch filtering and database integrity handling for call graph data

## [0.5.1] - 2026-03-01

### Added
- **Custom embedding provider**: Support for any OpenAI-compatible embedding endpoint (`custom` provider with `baseUrl`, `model`, `dimensions` config). Works with llama.cpp, vLLM, text-embeddings-inference, LiteLLM, etc.

### Fixed
- **Critical: infinite recursion on stale lock file**: When a stale `indexing.lock` existed from a crashed session, `initialize()` entered infinite recursion via `recoverFromInterruptedIndexing()` → `healthCheck()` → `ensureInitialized()` → `initialize()`, causing 70GB+ memory usage and OOM. Recovery now runs after store/database initialization.
- **Relative path storage**: Index now stores relative paths for project portability. Detects and warns about legacy absolute-path indexes.
- **MCP status prompt**: Removed empty args schema from status prompt that caused validation errors

### Changed
- **Changelog and README**: Fixed bullet formatting, added platform support table

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

[Unreleased]: https://github.com/Helweg/opencode-codebase-index/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/Helweg/opencode-codebase-index/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.5.0...v0.5.1
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
