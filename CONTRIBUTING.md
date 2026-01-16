# Contributing to opencode-codebase-index

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/opencode-codebase-index.git
   cd opencode-codebase-index
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Build the project**:
   ```bash
   npm run build
   ```

## Development Setup

### Prerequisites

- Node.js >= 18
- Rust toolchain (for native module)
- npm

### Building

```bash
# Build everything (TypeScript + Rust)
npm run build

# Build only TypeScript
npm run build:ts

# Build only Rust native module
npm run build:native
```

### Testing

```bash
# Run all tests
npm run test:run

# Run tests in watch mode
npm run test

# Run Rust tests
cd native && cargo test
```

### Linting

```bash
# Run ESLint
npm run lint

# Run Clippy (Rust)
cd native && cargo clippy
```

## Making Changes

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make your changes** and add tests if applicable

3. **Run checks** before committing:
   ```bash
   npm run build && npm run test:run && npm run lint
   ```

4. **Commit with a descriptive message**:
   ```bash
   git commit -m "feat: add my feature"
   ```
   
   We follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` - New feature
   - `fix:` - Bug fix
   - `docs:` - Documentation changes
   - `perf:` - Performance improvement
   - `refactor:` - Code refactoring
   - `test:` - Adding/updating tests
   - `chore:` - Maintenance tasks

5. **Push and open a pull request**:
   ```bash
   git push origin feature/my-feature
   ```

## Pull Request Guidelines

- Keep PRs focused and atomic
- Include tests for new functionality
- Update documentation if needed
- Ensure CI passes before requesting review

## Project Structure

```
src/                  # TypeScript source
  ├── indexer/        # Core indexing logic
  ├── embeddings/     # Embedding providers
  ├── tools/          # OpenCode tool definitions
  ├── native/         # Rust module wrapper
  └── config/         # Configuration schema

native/src/           # Rust native module
  ├── parser.rs       # Tree-sitter parsing
  ├── store.rs        # Vector storage
  └── inverted_index.rs # BM25 search

tests/                # Unit tests
```

## Questions?

Open an issue for any questions or concerns. We're happy to help!
