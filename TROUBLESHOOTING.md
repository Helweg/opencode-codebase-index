# Troubleshooting Guide

Common issues and solutions for opencode-codebase-index.

## Table of Contents

- [OpenCode Hangs in Home Directory](#opencode-hangs-in-home-directory)
- [No Embedding Provider Available](#no-embedding-provider-available)
- [Rate Limiting Errors](#rate-limiting-errors)
- [Index Corruption / Stale Results](#index-corruption--stale-results)
- [Embedding Provider Changed](#embedding-provider-changed)
- [Native Module Build Failures](#native-module-build-failures)
- [Slow Indexing Performance](#slow-indexing-performance)
- [Search Returns No Results](#search-returns-no-results)
- [Branch-Related Issues](#branch-related-issues)

---

## OpenCode Hangs in Home Directory

**Symptoms:**
- OpenCode becomes unresponsive when opened in home directory (`~`)
- New session starts but nothing happens when typing
- High CPU or memory usage

**Cause:** The plugin's file watcher attempts to watch the entire home directory, which contains hundreds of thousands of files.

**Solutions:**

### Default Behavior (v0.4.1+)
The plugin now requires a project marker (`.git`, `package.json`, `Cargo.toml`, etc.) by default. If no marker is found, file watching and auto-indexing are disabled. You'll see this warning:
```
[codebase-index] Skipping file watching and auto-indexing: no project marker found
```

### If You Need to Index a Non-Project Directory
Set `requireProjectMarker` to `false` in your config:
```json
{
  "indexing": {
    "requireProjectMarker": false
  }
}
```

**Warning:** Only do this for specific directories you intend to index. Never disable this for your home directory.

### Recognized Project Markers
The plugin looks for any of these files/directories:
- `.git`
- `package.json`
- `Cargo.toml`
- `go.mod`
- `pyproject.toml`
- `setup.py`
- `requirements.txt`
- `Gemfile`
- `composer.json`
- `pom.xml`
- `build.gradle`
- `CMakeLists.txt`
- `Makefile`
- `.opencode`

---

## No Embedding Provider Available

**Error message:**
```
No embedding provider available. Configure GitHub, OpenAI, Google, or Ollama.
```

**Cause:** The plugin cannot find any configured embedding provider credentials.

**Solutions:**

### Option 1: Use GitHub Copilot (if you have a subscription)
No additional configuration needed. The plugin automatically detects Copilot credentials.

### Option 2: Use OpenAI
```bash
export OPENAI_API_KEY=sk-...
```

Or set in your shell profile (`~/.bashrc`, `~/.zshrc`).

### Option 3: Use Google (Gemini)
```bash
export GOOGLE_API_KEY=...
```

### Option 4: Use Ollama (local, free)
```bash
# Install Ollama from https://ollama.ai
# Then pull the embedding model:
ollama pull nomic-embed-text
```

```json
// .opencode/codebase-index.json
{
  "embeddingProvider": "ollama"
}
```

### Verify Provider Detection
Run `/status` in OpenCode to see which provider is detected.

---

## Rate Limiting Errors

**Error messages:**
```
429 Too Many Requests
Rate limit exceeded
Too many requests
```

**Cause:** The embedding provider is rejecting requests due to rate limits.

**Solutions:**

### For GitHub Copilot
GitHub Copilot has strict rate limits (~15 requests/minute). The plugin automatically:
- Uses concurrency of 1
- Adds 4-second delays between requests
- Retries with exponential backoff

**If still hitting limits:**
1. Wait 1-2 minutes and retry
2. Switch to a different provider for large codebases:
   ```json
   { "embeddingProvider": "ollama" }
   ```

### For OpenAI
OpenAI has generous limits, but if you hit them:
1. Check your OpenAI account tier (free tier has lower limits)
2. Consider upgrading to a paid tier
3. Use Ollama for initial indexing, then switch back

### For Google
Similar to OpenAI. Check your quota at [Google Cloud Console](https://console.cloud.google.com/).

### For Large Codebases (1k+ files)
Use Ollama locally - no rate limits:
```bash
ollama pull nomic-embed-text
```
```json
{ "embeddingProvider": "ollama" }
```

---

## Index Corruption / Stale Results

**Symptoms:**
- Search returns deleted files
- Results don't match current code
- "Chunk not found" errors

**Solutions:**

### Run Health Check
```
/status
```
Then ask the agent to run `index_health_check` to remove orphaned entries.

### Force Re-index
Ask the agent:
> "Force reindex the codebase"

Or manually:
```bash
rm -rf .opencode/index/
```
Then run `/index`.

### Reset Everything
Delete the entire index directory:
```bash
rm -rf .opencode/index/
```

The next `/index` will rebuild from scratch.

---

## Embedding Provider Changed

**Error message:**
```
Index incompatible: <reason>. Run index with force=true to rebuild.
```

**Cause:** The index was built with a different embedding provider or model than what's currently configured. Embeddings from different providers have different dimensions and are not compatible.

**Common scenarios:**
- Switched from GitHub Copilot to OpenAI
- Changed Ollama embedding model
- Updated to a new version of the embedding model

**Solutions:**

### Force Re-index
Ask the agent:
> "Force reindex the codebase"

Or run `/index` with the force option. This will:
1. Delete all existing embeddings
2. Re-index all files with the new provider

### Why This Happens
Different embedding providers produce vectors with different dimensions:

| Provider | Model | Dimensions |
|----------|-------|------------|
| GitHub Copilot | text-embedding-3-small | 1536 |
| OpenAI | text-embedding-3-small | 1536 |
| Google | text-embedding-004 | 768 |
| Ollama | nomic-embed-text | 768 |

Mixing embeddings from different providers would produce garbage search results, so the plugin refuses to search until you rebuild the index.

### Check Current Index Metadata
Run `/status` to see what provider/model the index was built with.

---

## Native Module Build Failures

**Error messages:**
```
Error loading native module
NAPI_RS error
dyld: Library not loaded
```

**Cause:** The pre-built native binary for your platform is missing or incompatible.

**Solutions:**

### Check Supported Platforms
Pre-built binaries are available for:
- macOS x64 (Intel)
- macOS arm64 (Apple Silicon)
- Linux x64 (glibc)
- Linux arm64 (glibc)
- Windows x64

### Rebuild from Source
Requires Rust toolchain:
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Rebuild native module
cd native
cargo build --release
npx napi build --release --platform
```

### Linux Musl Issues
If on Alpine Linux or musl-based systems, you need to build from source:
```bash
# Install musl target
rustup target add x86_64-unknown-linux-musl

# Build
cd native
cargo build --release --target x86_64-unknown-linux-musl
```

---

## Slow Indexing Performance

**Symptoms:**
- Initial indexing takes very long
- Progress seems stuck

**Causes and Solutions:**

### 1. Large Codebase with Cloud Provider
Cloud providers have network latency and rate limits.

**Solution:** Use Ollama locally:
```bash
ollama pull nomic-embed-text
```
```json
{ "embeddingProvider": "ollama" }
```

### 2. Many Large Files
Files over 1MB are skipped by default, but many medium-sized files can still be slow.

**Solution:** Increase chunk limits or enable semantic-only mode:
```json
{
  "indexing": {
    "semanticOnly": true,
    "maxChunksPerFile": 50
  }
}
```

### 3. GitHub Copilot Rate Limits
Copilot has 4-second delays between requests.

**Solution:** For initial indexing, use a faster provider, then switch back:
```json
{ "embeddingProvider": "openai" }
```

### Check Progress
Run `/status` to see current index stats and estimate remaining work with:
> "Estimate indexing cost"

---

## Search Returns No Results

**Symptoms:**
- Queries return empty results
- "No matches found" for queries that should match

**Solutions:**

### 1. Check Index Status
```
/status
```
Verify the index exists and has chunks.

### 2. Index Hasn't Run Yet
Run `/index` to index the codebase.

### 3. Query Too Vague or Too Specific
Semantic search works best with descriptive queries:

| Bad Query | Better Query |
|-----------|--------------|
| "auth" | "authentication middleware that validates JWT tokens" |
| "error" | "error handling for failed API calls" |
| "user" | "function that creates new user accounts" |

### 4. Similarity Threshold Too High
Lower the minimum score:
```json
{
  "search": {
    "minScore": 0.05
  }
}
```

### 5. Files Excluded
Check if your files are being excluded by `.gitignore` or size limits:
> "Index with verbose mode"

This shows which files were skipped and why.

---

## Branch-Related Issues

### Stale Results After Branch Switch

**Cause:** The branch catalog may not have updated.

**Solution:**
1. Check current branch detection:
   ```
   /status
   ```
2. Re-index to update the branch catalog:
   ```
   /index
   ```

### Wrong Branch Detected

**Cause:** Detached HEAD or unusual git state.

**Solution:** Check your git state:
```bash
git status
cat .git/HEAD
```

The plugin reads `.git/HEAD` directly. If you're in detached HEAD state, it uses the commit SHA as the "branch" name.

### Index Not Updating on Branch Switch

**Cause:** File watcher may not be running.

**Solution:** Enable file watching:
```json
{
  "indexing": {
    "watchFiles": true
  }
}
```

Or manually trigger re-index after switching branches:
```
/index
```

---

## Getting Help

If none of these solutions work:

1. **Check logs:** Look for error messages in the OpenCode output
2. **Verbose indexing:** Run with verbose mode to see detailed progress
3. **GitHub Issues:** [Open an issue](https://github.com/Helweg/opencode-codebase-index/issues) with:
   - Error message
   - OS and Node.js version
   - Provider being used
   - Steps to reproduce

---

## Quick Reference

| Problem | Quick Fix |
|---------|-----------|
| Hangs in home dir | Update to v0.4.1+ (auto-detects non-project dirs) |
| No provider | `export OPENAI_API_KEY=...` or use Ollama |
| Rate limited | Switch to Ollama for large codebases |
| Stale results | `rm -rf .opencode/index/` and re-index |
| Provider changed | Force re-index: ask agent to "force reindex" |
| Slow indexing | Use Ollama locally |
| No results | Run `/index` first, use descriptive queries |
| Native module error | Rebuild with Rust toolchain |
