# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
