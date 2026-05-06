/**
 * PostgreSQL / pgvector implementations of IDatabaseBackend and IVectorStoreBackend.
 *
 * Requires:
 *   - PostgreSQL 14+ with the pgvector extension (CREATE EXTENSION vector)
 *   - The `pg` npm package (node-postgres)
 *
 * All tables use a configurable prefix (default "ci_") so that multiple
 * independent indexes can coexist in the same database.
 *
 * Security note: every query uses parameterized statements ($1, $2, …) to
 * prevent SQL injection.  Table / column names are derived only from the
 * validated tablePrefix config value (sanitized to [a-zA-Z0-9_] only).
 */

import { createHash } from "crypto";
import type {
  IDatabaseBackend,
  IVectorStoreBackend,
  VectorSearchResult,
} from "./backend.js";
import type {
  ChunkData,
  BranchDelta,
  DatabaseStats,
  SymbolData,
  CallEdgeData,
  ChunkMetadata,
} from "./backend.js";
import type { PgVectorConfig } from "../config/schema.js";

// ── Lazy import of `pg` ────────────────────────────────────────────────────
// `pg` is an optional runtime dependency.  We import it lazily so that users
// who only use the SQLite backend never pay the cost of loading it.

type PgPool = import("pg").Pool;
type PgPoolClient = import("pg").PoolClient;
type PgSslMode = "disable" | "require" | "verify-full";

async function loadPg(): Promise<typeof import("pg")> {
  try {
    return await import("pg");
  } catch {
    throw new Error(
      "[codebase-index] The `pg` package is required for the pgvector database backend. " +
        "Install it with: npm install pg"
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pgSslConfig(mode: PgSslMode | undefined): boolean | { rejectUnauthorized: boolean } | undefined {
  if (!mode || mode === "disable") return undefined;
  if (mode === "require") return { rejectUnauthorized: false };
  return true; // verify-full
}

/**
 * Replicates the Rust InvertedIndex tokenizer: lowercase, replace
 * non-alphanumeric with space, split on whitespace, drop tokens ≤ 2 chars.
 */
function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/** Format a Float32Array / number[] as pgvector literal: '[1.0,2.0,...]' */
function formatVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function rowToChunkData(row: Record<string, unknown>): ChunkData {
  return {
    chunkId: row.chunk_id as string,
    contentHash: row.content_hash as string,
    filePath: row.file_path as string,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    nodeType: (row.node_type as string | null) ?? undefined,
    name: (row.name as string | null) ?? undefined,
    language: row.language as string,
  };
}

function rowToSymbolData(row: Record<string, unknown>): SymbolData {
  return {
    id: row.id as string,
    filePath: row.file_path as string,
    name: row.name as string,
    kind: row.kind as string,
    startLine: Number(row.start_line),
    startCol: Number(row.start_col),
    endLine: Number(row.end_line),
    endCol: Number(row.end_col),
    language: row.language as string,
  };
}

function rowToCallEdgeData(row: Record<string, unknown>, withContext = false): CallEdgeData {
  return {
    id: row.id as string,
    fromSymbolId: row.from_symbol_id as string,
    fromSymbolName: withContext ? ((row.from_symbol_name as string | null) ?? undefined) : undefined,
    fromSymbolFilePath: withContext ? ((row.from_symbol_file_path as string | null) ?? undefined) : undefined,
    targetName: row.target_name as string,
    toSymbolId: (row.to_symbol_id as string | null) ?? undefined,
    callType: row.call_type as string,
    line: Number(row.line),
    col: Number(row.col),
    isResolved: Boolean(row.is_resolved),
  };
}

// ── PgVectorStoreBackend ─────────────────────────────────────────────────────

export class PgVectorStoreBackend implements IVectorStoreBackend {
  private pool: PgPool | null = null;
  private dimensions = 0;
  private readonly config: PgVectorConfig;
  private readonly prefix: string;

  constructor(config: PgVectorConfig) {
    this.config = config;
    this.prefix = config.tablePrefix ?? "ci";
  }

  private get vectorsTable(): string {
    return `${this.prefix}_chunk_vectors`;
  }

  private async getPool(): Promise<PgPool> {
    if (!this.pool) throw new Error("PgVectorStoreBackend not initialized");
    return this.pool;
  }

  async initialize(dimensions: number): Promise<void> {
    this.dimensions = dimensions;

    const pg = await loadPg();
    const cfg = this.config;

    this.pool = new pg.Pool(
      cfg.connectionString
        ? {
            connectionString: cfg.connectionString,
            max: cfg.poolSize ?? 10,
            connectionTimeoutMillis: cfg.connectionTimeoutMs ?? 5000,
            ssl: pgSslConfig(cfg.ssl) as import("pg").PoolConfig["ssl"],
          }
        : {
            host: cfg.host ?? "localhost",
            port: cfg.port ?? 5432,
            database: cfg.database ?? "postgres",
            user: cfg.user ?? "postgres",
            password: cfg.password,
            max: cfg.poolSize ?? 10,
            connectionTimeoutMillis: cfg.connectionTimeoutMs ?? 5000,
            ssl: pgSslConfig(cfg.ssl) as import("pg").PoolConfig["ssl"],
          }
    );

    const client = await this.pool.connect();
    try {
      // Ensure pgvector extension is installed before any schema work.
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");

      // Create the chunk_vectors table with the correct dimension.
      // We store the embedding as both a pgvector `vector` column (for ANN
      // search) and — on the companion PgDatabaseBackend — as raw BYTEA for
      // fast byte-exact retrieval.  Here we only manage the vector side.
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.vectorsTable} (
          chunk_id   TEXT PRIMARY KEY,
          embedding  vector(${dimensions}),
          file_path  TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line   INTEGER NOT NULL,
          chunk_type TEXT NOT NULL,
          name       TEXT,
          language   TEXT NOT NULL,
          hash       TEXT NOT NULL,
          source_id  TEXT NOT NULL DEFAULT ''
        )
      `);

      // HNSW index for fast approximate nearest-neighbour search.
      // Using cosine distance, consistent with the usearch backend.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.vectorsTable}_embedding_idx
          ON ${this.vectorsTable}
          USING hnsw (embedding vector_cosine_ops)
      `);

      // Migration: add source_id for multi-source isolation (idempotent).
      await client.query(`
        ALTER TABLE ${this.vectorsTable}
          ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT ''
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.vectorsTable}_source_idx
          ON ${this.vectorsTable} (source_id)
      `);
    } finally {
      client.release();
    }
  }

  /** No-op: pgvector persists writes immediately. */
  async load(): Promise<void> {}
  async save(): Promise<void> {}

  async add(id: string, vector: number[], metadata: ChunkMetadata, sourceId?: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.vectorsTable}
         (chunk_id, embedding, file_path, start_line, end_line, chunk_type, name, language, hash, source_id)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (chunk_id) DO UPDATE SET
         embedding  = EXCLUDED.embedding,
         file_path  = EXCLUDED.file_path,
         start_line = EXCLUDED.start_line,
         end_line   = EXCLUDED.end_line,
         chunk_type = EXCLUDED.chunk_type,
         name       = EXCLUDED.name,
         language   = EXCLUDED.language,
         hash       = EXCLUDED.hash,
         source_id  = EXCLUDED.source_id`,
      [
        id,
        formatVector(vector),
        metadata.filePath,
        metadata.startLine,
        metadata.endLine,
        metadata.chunkType,
        metadata.name ?? null,
        metadata.language,
        metadata.hash,
        sourceId ?? "",
      ]
    );
  }

  async addBatch(
    items: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }>,
    sourceId?: string
  ): Promise<void> {
    if (items.length === 0) return;
    const pool = await this.getPool();
    const client = await pool.connect();
    const sid = sourceId ?? "";
    try {
      await client.query("BEGIN");
      for (const item of items) {
        await client.query(
          `INSERT INTO ${this.vectorsTable}
             (chunk_id, embedding, file_path, start_line, end_line, chunk_type, name, language, hash, source_id)
           VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (chunk_id) DO UPDATE SET
             embedding  = EXCLUDED.embedding,
             file_path  = EXCLUDED.file_path,
             start_line = EXCLUDED.start_line,
             end_line   = EXCLUDED.end_line,
             chunk_type = EXCLUDED.chunk_type,
             name       = EXCLUDED.name,
             language   = EXCLUDED.language,
             hash       = EXCLUDED.hash,
             source_id  = EXCLUDED.source_id`,
          [
            item.id,
            formatVector(item.vector),
            item.metadata.filePath,
            item.metadata.startLine,
            item.metadata.endLine,
            item.metadata.chunkType,
            item.metadata.name ?? null,
            item.metadata.language,
            item.metadata.hash,
            sid,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async search(queryVector: number[], limit: number, sourceIds?: string[]): Promise<VectorSearchResult[]> {
    const pool = await this.getPool();
    const vectorStr = formatVector(queryVector);
    let queryText: string;
    let params: unknown[];
    if (sourceIds && sourceIds.length > 0) {
      queryText = `SELECT chunk_id,
              1 - (embedding <=> $1::vector) AS score,
              file_path, start_line, end_line, chunk_type, name, language, hash
       FROM ${this.vectorsTable}
       WHERE source_id = ANY($3::text[])
       ORDER BY embedding <=> $1::vector
       LIMIT $2`;
      params = [vectorStr, limit, sourceIds];
    } else {
      queryText = `SELECT chunk_id,
              1 - (embedding <=> $1::vector) AS score,
              file_path, start_line, end_line, chunk_type, name, language, hash
       FROM ${this.vectorsTable}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`;
      params = [vectorStr, limit];
    }
    const { rows } = await pool.query<Record<string, unknown>>(queryText, params);

    return rows.map((row) => ({
      id: row.chunk_id as string,
      score: Number(row.score),
      metadata: {
        filePath: row.file_path as string,
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        chunkType: row.chunk_type as ChunkMetadata["chunkType"],
        name: (row.name as string | null) ?? undefined,
        language: row.language as string,
        hash: row.hash as string,
      },
    }));
  }

  async remove(id: string): Promise<boolean> {
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.vectorsTable} WHERE chunk_id = $1`,
      [id]
    );
    return (rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM ${this.vectorsTable}`
    );
    return parseInt(rows[0]?.cnt ?? "0", 10);
  }

  async clear(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`TRUNCATE TABLE ${this.vectorsTable}`);
  }

  getDimensions(): number {
    return this.dimensions;
  }

  async getAllKeys(): Promise<string[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ chunk_id: string }>(
      `SELECT chunk_id FROM ${this.vectorsTable}`
    );
    return rows.map((r) => r.chunk_id);
  }

  async getAllMetadata(): Promise<Array<{ key: string; metadata: ChunkMetadata }>> {
    const pool = await this.getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT chunk_id, file_path, start_line, end_line, chunk_type, name, language, hash
       FROM ${this.vectorsTable}`
    );
    return rows.map((row) => ({
      key: row.chunk_id as string,
      metadata: {
        filePath: row.file_path as string,
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        chunkType: row.chunk_type as ChunkMetadata["chunkType"],
        name: (row.name as string | null) ?? undefined,
        language: row.language as string,
        hash: row.hash as string,
      },
    }));
  }

  async getMetadata(id: string): Promise<ChunkMetadata | undefined> {
    const pool = await this.getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT file_path, start_line, end_line, chunk_type, name, language, hash
       FROM ${this.vectorsTable}
       WHERE chunk_id = $1`,
      [id]
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      filePath: row.file_path as string,
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      chunkType: row.chunk_type as ChunkMetadata["chunkType"],
      name: (row.name as string | null) ?? undefined,
      language: row.language as string,
      hash: row.hash as string,
    };
  }

  async getMetadataBatch(ids: string[]): Promise<Map<string, ChunkMetadata>> {
    if (ids.length === 0) return new Map();
    const pool = await this.getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT chunk_id, file_path, start_line, end_line, chunk_type, name, language, hash
       FROM ${this.vectorsTable}
       WHERE chunk_id = ANY($1::text[])`,
      [ids]
    );
    const map = new Map<string, ChunkMetadata>();
    for (const row of rows) {
      map.set(row.chunk_id as string, {
        filePath: row.file_path as string,
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        chunkType: row.chunk_type as ChunkMetadata["chunkType"],
        name: (row.name as string | null) ?? undefined,
        language: row.language as string,
        hash: row.hash as string,
      });
    }
    return map;
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}

// ── PgDatabaseBackend ────────────────────────────────────────────────────────

export class PgDatabaseBackend implements IDatabaseBackend {
  private pool: PgPool | null = null;
  private readonly config: PgVectorConfig;
  private readonly p: string; // table prefix

  constructor(config: PgVectorConfig) {
    this.config = config;
    this.p = config.tablePrefix ?? "ci";
  }

  // Convenience getter for fully-qualified table names.
  private t(name: string): string {
    return `${this.p}_${name}`;
  }

  private async getPool(): Promise<PgPool> {
    if (!this.pool) throw new Error("PgDatabaseBackend not initialized");
    return this.pool;
  }

  private async withClient<T>(fn: (client: PgPoolClient) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async initialize(): Promise<void> {
    const pg = await loadPg();
    const cfg = this.config;

    this.pool = new pg.Pool(
      cfg.connectionString
        ? {
            connectionString: cfg.connectionString,
            max: cfg.poolSize ?? 10,
            connectionTimeoutMillis: cfg.connectionTimeoutMs ?? 5000,
            ssl: pgSslConfig(cfg.ssl) as import("pg").PoolConfig["ssl"],
          }
        : {
            host: cfg.host ?? "localhost",
            port: cfg.port ?? 5432,
            database: cfg.database ?? "postgres",
            user: cfg.user ?? "postgres",
            password: cfg.password,
            max: cfg.poolSize ?? 10,
            connectionTimeoutMillis: cfg.connectionTimeoutMs ?? 5000,
            ssl: pgSslConfig(cfg.ssl) as import("pg").PoolConfig["ssl"],
          }
    );

    await this.createSchema();
  }

  private async createSchema(): Promise<void> {
    await this.withClient(async (client) => {
      // Ensure pgvector extension is installed before any schema work.
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");

      // ── Sources registry ─────────────────────────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("sources")} (
          source_id   TEXT PRIMARY KEY,
          root_path   TEXT NOT NULL UNIQUE,
          created_at  BIGINT NOT NULL
        )
      `);

      // ── Core tables ──────────────────────────────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("metadata")} (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("embeddings")} (
          content_hash TEXT PRIMARY KEY,
          embedding    BYTEA NOT NULL,
          chunk_text   TEXT NOT NULL,
          model        TEXT NOT NULL,
          created_at   BIGINT NOT NULL
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("chunks")} (
          chunk_id     TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          file_path    TEXT NOT NULL,
          start_line   INTEGER NOT NULL,
          end_line     INTEGER NOT NULL,
          node_type    TEXT,
          name         TEXT,
          language     TEXT NOT NULL,
          source_id    TEXT NOT NULL DEFAULT ''
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("chunks_content_hash_idx")}
          ON ${this.t("chunks")} (content_hash)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("chunks_file_path_idx")}
          ON ${this.t("chunks")} (file_path)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("chunks_name_idx")}
          ON ${this.t("chunks")} (name)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("chunks_name_lower_idx")}
          ON ${this.t("chunks")} (lower(name))
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("branch_chunks")} (
          source_id TEXT NOT NULL DEFAULT '',
          branch    TEXT NOT NULL,
          chunk_id  TEXT NOT NULL,
          PRIMARY KEY (source_id, branch, chunk_id)
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("symbols")} (
          id         TEXT PRIMARY KEY,
          file_path  TEXT NOT NULL,
          name       TEXT NOT NULL,
          kind       TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          start_col  INTEGER NOT NULL,
          end_line   INTEGER NOT NULL,
          end_col    INTEGER NOT NULL,
          language   TEXT NOT NULL,
          source_id  TEXT NOT NULL DEFAULT ''
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("symbols_file_path_idx")}
          ON ${this.t("symbols")} (file_path)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("symbols_name_idx")}
          ON ${this.t("symbols")} (name)
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("call_edges")} (
          id             TEXT PRIMARY KEY,
          from_symbol_id TEXT NOT NULL,
          target_name    TEXT NOT NULL,
          to_symbol_id   TEXT,
          call_type      TEXT NOT NULL,
          line           INTEGER NOT NULL,
          col            INTEGER NOT NULL,
          is_resolved    BOOLEAN NOT NULL DEFAULT FALSE,
          source_id      TEXT NOT NULL DEFAULT ''
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("call_edges_from_idx")}
          ON ${this.t("call_edges")} (from_symbol_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("call_edges_to_idx")}
          ON ${this.t("call_edges")} (to_symbol_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("call_edges_target_idx")}
          ON ${this.t("call_edges")} (target_name)
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("branch_symbols")} (
          source_id TEXT NOT NULL DEFAULT '',
          branch    TEXT NOT NULL,
          symbol_id TEXT NOT NULL,
          PRIMARY KEY (source_id, branch, symbol_id)
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("file_hashes")} (
          source_id TEXT NOT NULL DEFAULT '',
          file_path TEXT NOT NULL,
          hash      TEXT NOT NULL,
          PRIMARY KEY (source_id, file_path)
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("inverted_index_postings")} (
          term        TEXT    NOT NULL,
          chunk_id    TEXT    NOT NULL,
          token_count INTEGER NOT NULL,
          PRIMARY KEY (term, chunk_id)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("iip_term_idx")}
          ON ${this.t("inverted_index_postings")} (term)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("iip_chunk_idx")}
          ON ${this.t("inverted_index_postings")} (chunk_id)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.t("inverted_index_doc_lengths")} (
          chunk_id TEXT    PRIMARY KEY,
          doc_len  INTEGER NOT NULL
        )
      `);

      // ── Migrations for existing databases ────────────────────────
      // Add source_id columns to tables that may have been created before
      // this schema version.  ADD COLUMN IF NOT EXISTS is idempotent.
      await client.query(`ALTER TABLE ${this.t("chunks")}        ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT ''`);
      await client.query(`ALTER TABLE ${this.t("symbols")}       ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT ''`);
      await client.query(`ALTER TABLE ${this.t("call_edges")}    ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT ''`);

      // For tables whose PK must gain a source_id prefix, only run the
      // DROP+ADD when source_id is not yet part of the primary key —
      // avoids an ACCESS EXCLUSIVE lock on every startup.
      const pkNeedsMigration = async (table: string): Promise<boolean> => {
        const { rows } = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM   pg_index     i
             JOIN   pg_attribute a ON a.attrelid = i.indrelid
                                  AND a.attnum   = ANY(i.indkey)
             WHERE  i.indrelid  = $1::regclass
               AND  i.indisprimary
               AND  a.attname   = 'source_id'
           ) AS exists`,
          [table]
        );
        return !rows[0]!.exists;
      };

      // branch_chunks: old PK was (branch, chunk_id); new PK is (source_id, branch, chunk_id).
      await client.query(`ALTER TABLE ${this.t("branch_chunks")} ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT ''`);
      if (await pkNeedsMigration(this.t("branch_chunks"))) {
        await client.query(`ALTER TABLE ${this.t("branch_chunks")} DROP CONSTRAINT IF EXISTS ${this.t("branch_chunks_pkey")}`);
        await client.query(`ALTER TABLE ${this.t("branch_chunks")} ADD PRIMARY KEY (source_id, branch, chunk_id)`);
      }

      // branch_symbols: old PK was (branch, symbol_id); new PK is (source_id, branch, symbol_id).
      await client.query(`ALTER TABLE ${this.t("branch_symbols")} ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT ''`);
      if (await pkNeedsMigration(this.t("branch_symbols"))) {
        await client.query(`ALTER TABLE ${this.t("branch_symbols")} DROP CONSTRAINT IF EXISTS ${this.t("branch_symbols_pkey")}`);
        await client.query(`ALTER TABLE ${this.t("branch_symbols")} ADD PRIMARY KEY (source_id, branch, symbol_id)`);
      }

      // file_hashes: old PK was (file_path); new PK is (source_id, file_path).
      await client.query(`ALTER TABLE ${this.t("file_hashes")} ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT ''`);
      if (await pkNeedsMigration(this.t("file_hashes"))) {
        await client.query(`ALTER TABLE ${this.t("file_hashes")} DROP CONSTRAINT IF EXISTS ${this.t("file_hashes_pkey")}`);
        await client.query(`ALTER TABLE ${this.t("file_hashes")} ADD PRIMARY KEY (source_id, file_path)`);
      }

      // ── Indexes on source_id (must come after ADD COLUMN migrations) ─
      // These are deferred so that CREATE INDEX doesn't fire before the
      // column exists on databases that pre-date source_id support.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("chunks_source_idx")}
          ON ${this.t("chunks")} (source_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("symbols_source_idx")}
          ON ${this.t("symbols")} (source_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("call_edges_source_idx")}
          ON ${this.t("call_edges")} (source_id)
      `);
      // Add source-aware composite branch indexes. We intentionally use new
      // names to avoid collisions with legacy branch-only indexes on existing
      // databases and to keep migration idempotent across concurrent initializers.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("branch_chunks_source_branch_idx")}
          ON ${this.t("branch_chunks")} (source_id, branch)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.t("branch_symbols_source_branch_idx")}
          ON ${this.t("branch_symbols")} (source_id, branch)
      `);
    });
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  supportsSourceIsolation(): boolean {
    return true;
  }

  async getOrCreateSource(rootPath: string): Promise<string> {
    const sourceId = createHash("sha256").update(rootPath).digest("hex").slice(0, 32);
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.t("sources")} (source_id, root_path, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (source_id) DO NOTHING`,
      [sourceId, rootPath, Date.now()]
    );
    return sourceId;
  }

  // ── Embeddings ───────────────────────────────────────────────────

  async embeddingExists(contentHash: string): Promise<boolean> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM ${this.t("embeddings")} WHERE content_hash = $1`,
      [contentHash]
    );
    return parseInt(rows[0]?.cnt ?? "0", 10) > 0;
  }

  async getEmbedding(contentHash: string): Promise<Buffer | null> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ embedding: Buffer }>(
      `SELECT embedding FROM ${this.t("embeddings")} WHERE content_hash = $1`,
      [contentHash]
    );
    return rows[0]?.embedding ?? null;
  }

  async upsertEmbedding(
    contentHash: string,
    embedding: Buffer,
    chunkText: string,
    model: string
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.t("embeddings")} (content_hash, embedding, chunk_text, model, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (content_hash) DO UPDATE SET
         embedding  = EXCLUDED.embedding,
         model      = EXCLUDED.model`,
      [contentHash, embedding, chunkText, model, Date.now()]
    );
  }

  async upsertEmbeddingsBatch(
    items: Array<{ contentHash: string; embedding: Buffer; chunkText: string; model: string }>
  ): Promise<void> {
    if (items.length === 0) return;
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const item of items) {
        await client.query(
          `INSERT INTO ${this.t("embeddings")} (content_hash, embedding, chunk_text, model, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (content_hash) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             model     = EXCLUDED.model`,
          [item.contentHash, item.embedding, item.chunkText, item.model, Date.now()]
        );
      }
      await client.query("COMMIT");
    });
  }

  async getMissingEmbeddings(contentHashes: string[]): Promise<string[]> {
    if (contentHashes.length === 0) return [];
    const pool = await this.getPool();
    const { rows } = await pool.query<{ content_hash: string }>(
      `SELECT content_hash FROM ${this.t("embeddings")}
       WHERE content_hash = ANY($1::text[])`,
      [contentHashes]
    );
    const existing = new Set(rows.map((r) => r.content_hash));
    return contentHashes.filter((h) => !existing.has(h));
  }

  // ── Chunks ────────────────────────────────────────────────────────

  async upsertChunk(chunk: ChunkData): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.t("chunks")}
         (chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (chunk_id) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         file_path    = EXCLUDED.file_path,
         start_line   = EXCLUDED.start_line,
         end_line     = EXCLUDED.end_line,
         node_type    = EXCLUDED.node_type,
         name         = EXCLUDED.name,
         language     = EXCLUDED.language`,
      [
        chunk.chunkId, chunk.contentHash, chunk.filePath,
        chunk.startLine, chunk.endLine,
        chunk.nodeType ?? null, chunk.name ?? null, chunk.language,
      ]
    );
  }

  async upsertChunksBatch(chunks: ChunkData[], sourceId?: string): Promise<void> {
    if (chunks.length === 0) return;
    const sid = sourceId ?? "";
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO ${this.t("chunks")}
             (chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language, source_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (chunk_id) DO UPDATE SET
             content_hash = EXCLUDED.content_hash,
             file_path    = EXCLUDED.file_path,
             start_line   = EXCLUDED.start_line,
             end_line     = EXCLUDED.end_line,
             node_type    = EXCLUDED.node_type,
             name         = EXCLUDED.name,
             language     = EXCLUDED.language,
             source_id    = EXCLUDED.source_id`,
          [
            chunk.chunkId, chunk.contentHash, chunk.filePath,
            chunk.startLine, chunk.endLine,
            chunk.nodeType ?? null, chunk.name ?? null, chunk.language,
            sid,
          ]
        );
      }
      await client.query("COMMIT");
    });
  }

  async getChunk(chunkId: string): Promise<ChunkData | null> {
    const pool = await this.getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.t("chunks")} WHERE chunk_id = $1`,
      [chunkId]
    );
    return rows[0] ? rowToChunkData(rows[0]) : null;
  }

  async getChunksByFile(filePath: string, sourceId?: string): Promise<ChunkData[]> {
    const pool = await this.getPool();
    if (sourceId !== undefined) {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT * FROM ${this.t("chunks")} WHERE file_path = $1 AND source_id = $2 ORDER BY start_line`,
        [filePath, sourceId]
      );
      return rows.map(rowToChunkData);
    }
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.t("chunks")} WHERE file_path = $1 ORDER BY start_line`,
      [filePath]
    );
    return rows.map(rowToChunkData);
  }

  async getChunksByName(name: string): Promise<ChunkData[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.t("chunks")} WHERE name = $1`,
      [name]
    );
    return rows.map(rowToChunkData);
  }

  async getChunksByNameCi(name: string): Promise<ChunkData[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.t("chunks")} WHERE lower(name) = lower($1)`,
      [name]
    );
    return rows.map(rowToChunkData);
  }

  async deleteChunksByFile(filePath: string, sourceId?: string): Promise<number> {
    const pool = await this.getPool();
    if (sourceId !== undefined) {
      const { rowCount } = await pool.query(
        `DELETE FROM ${this.t("chunks")} WHERE file_path = $1 AND source_id = $2`,
        [filePath, sourceId]
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("chunks")} WHERE file_path = $1`,
      [filePath]
    );
    return rowCount ?? 0;
  }

  async getChunkFilePaths(sourceId?: string): Promise<string[]> {
    const pool = await this.getPool();
    if (sourceId !== undefined) {
      const { rows } = await pool.query(
        `SELECT DISTINCT file_path FROM ${this.t("chunks")} WHERE source_id = $1`,
        [sourceId]
      );
      return rows.map((r: { file_path: string }) => r.file_path);
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT file_path FROM ${this.t("chunks")}`
    );
    return rows.map((r: { file_path: string }) => r.file_path);
  }

  async getFilePathsInRoots(roots: string[]): Promise<string[]> {
    if (roots.length === 0) return [];
    const pool = await this.getPool();
    const conditions = roots.map((_, i) => `file_path LIKE $${i + 1}`).join(" OR ");
    const params = roots.map((root) => `${root}%`);
    const { rows } = await pool.query<{ file_path: string }>(
      `SELECT DISTINCT file_path FROM ${this.t("chunks")} WHERE ${conditions}`,
      params
    );
    return rows.map((r) => r.file_path);
  }

  // ── Branch catalog ────────────────────────────────────────────────

  async addChunksToBranch(branch: string, chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const id of chunkIds) {
        await client.query(
          `INSERT INTO ${this.t("branch_chunks")} (source_id, branch, chunk_id)
           VALUES ('', $1, $2) ON CONFLICT DO NOTHING`,
          [branch, id]
        );
      }
      await client.query("COMMIT");
    });
  }

  async addChunksToBranchBatch(branch: string, chunkIds: string[], sourceId?: string): Promise<void> {
    if (chunkIds.length === 0) return;
    const sid = sourceId ?? "";
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const id of chunkIds) {
        await client.query(
          `INSERT INTO ${this.t("branch_chunks")} (source_id, branch, chunk_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [sid, branch, id]
        );
      }
      await client.query("COMMIT");
    });
  }

  async clearBranch(branch: string, sourceId?: string): Promise<number> {
    const pool = await this.getPool();
    if (sourceId !== undefined) {
      const { rowCount } = await pool.query(
        `DELETE FROM ${this.t("branch_chunks")} WHERE branch = $1 AND source_id = $2`,
        [branch, sourceId]
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("branch_chunks")} WHERE branch = $1`,
      [branch]
    );
    return rowCount ?? 0;
  }

  async deleteBranchChunksByChunkIds(chunkIds: string[]): Promise<number> {
    if (chunkIds.length === 0) return 0;
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("branch_chunks")} WHERE chunk_id = ANY($1::text[])`,
      [chunkIds]
    );
    return rowCount ?? 0;
  }

  async deleteBranchChunksForBranch(branch: string, chunkIds: string[]): Promise<number> {
    if (chunkIds.length === 0) return 0;
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("branch_chunks")}
       WHERE branch = $1 AND chunk_id = ANY($2::text[])`,
      [branch, chunkIds]
    );
    return rowCount ?? 0;
  }

  async getBranchChunkIds(branch: string, sourceIds?: string[]): Promise<string[]> {
    const pool = await this.getPool();
    if (sourceIds && sourceIds.length > 0) {
      const { rows } = await pool.query<{ chunk_id: string }>(
        `SELECT chunk_id FROM ${this.t("branch_chunks")} WHERE branch = $1 AND source_id = ANY($2::text[])`,
        [branch, sourceIds]
      );
      return rows.map((r) => r.chunk_id);
    }
    const { rows } = await pool.query<{ chunk_id: string }>(
      `SELECT chunk_id FROM ${this.t("branch_chunks")} WHERE branch = $1`,
      [branch]
    );
    return rows.map((r) => r.chunk_id);
  }

  async getBranchDelta(branch: string, baseBranch: string): Promise<BranchDelta> {
    const pool = await this.getPool();
    const { rows: addedRows } = await pool.query<{ chunk_id: string }>(
      `SELECT chunk_id FROM ${this.t("branch_chunks")} WHERE branch = $1
       EXCEPT
       SELECT chunk_id FROM ${this.t("branch_chunks")} WHERE branch = $2`,
      [branch, baseBranch]
    );
    const { rows: removedRows } = await pool.query<{ chunk_id: string }>(
      `SELECT chunk_id FROM ${this.t("branch_chunks")} WHERE branch = $1
       EXCEPT
       SELECT chunk_id FROM ${this.t("branch_chunks")} WHERE branch = $2`,
      [baseBranch, branch]
    );
    return {
      added: addedRows.map((r) => r.chunk_id),
      removed: removedRows.map((r) => r.chunk_id),
    };
  }

  async getReferencedChunkIds(chunkIds: string[]): Promise<string[]> {
    if (chunkIds.length === 0) return [];
    const pool = await this.getPool();
    const { rows } = await pool.query<{ chunk_id: string }>(
      `SELECT DISTINCT chunk_id FROM ${this.t("branch_chunks")}
       WHERE chunk_id = ANY($1::text[])`,
      [chunkIds]
    );
    return rows.map((r) => r.chunk_id);
  }

  async chunkExistsOnBranch(branch: string, chunkId: string): Promise<boolean> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM ${this.t("branch_chunks")}
       WHERE branch = $1 AND chunk_id = $2`,
      [branch, chunkId]
    );
    return parseInt(rows[0]?.cnt ?? "0", 10) > 0;
  }

  async getAllBranches(): Promise<string[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ branch: string }>(
      `SELECT DISTINCT branch FROM ${this.t("branch_chunks")}`
    );
    return rows.map((r) => r.branch);
  }

  // ── Metadata key-value ────────────────────────────────────────────

  async getMetadata(key: string): Promise<string | null> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM ${this.t("metadata")} WHERE key = $1`,
      [key]
    );
    return rows[0]?.value ?? null;
  }

  async setMetadata(key: string, value: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.t("metadata")} (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  async deleteMetadata(key: string): Promise<boolean> {
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("metadata")} WHERE key = $1`,
      [key]
    );
    return (rowCount ?? 0) > 0;
  }

  // ── Maintenance ───────────────────────────────────────────────────

  async clearAllIndexedData(): Promise<void> {
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const table of [
        "branch_symbols", "branch_chunks",
        "call_edges", "symbols", "chunks", "embeddings", "file_hashes",
        "inverted_index_postings", "inverted_index_doc_lengths",
      ]) {
        await client.query(`TRUNCATE TABLE ${this.t(table)}`);
      }
      await client.query("COMMIT");
    });
  }

  async clearCallEdgeTargetsForSymbols(symbolIds: string[]): Promise<number> {
    if (symbolIds.length === 0) return 0;
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `UPDATE ${this.t("call_edges")} SET to_symbol_id = NULL, is_resolved = FALSE
       WHERE from_symbol_id = ANY($1::text[])`,
      [symbolIds]
    );
    return rowCount ?? 0;
  }

  async gcOrphanEmbeddings(): Promise<number> {
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("embeddings")} e
       WHERE NOT EXISTS (
         SELECT 1 FROM ${this.t("chunks")} c WHERE c.content_hash = e.content_hash
       )`
    );
    return rowCount ?? 0;
  }

  async gcOrphanChunks(): Promise<number> {
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("chunks")} c
       WHERE NOT EXISTS (
         SELECT 1 FROM ${this.t("branch_chunks")} bc WHERE bc.chunk_id = c.chunk_id
       )`
    );
    return rowCount ?? 0;
  }

  async getStats(): Promise<DatabaseStats> {
    const pool = await this.getPool();
    const queries = [
      pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${this.t("embeddings")}`),
      pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${this.t("chunks")}`),
      pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${this.t("branch_chunks")}`),
      pool.query<{ cnt: string }>(`SELECT COUNT(DISTINCT branch) AS cnt FROM ${this.t("branch_chunks")}`),
      pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${this.t("symbols")}`),
      pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${this.t("call_edges")}`),
    ];
    const results = await Promise.all(queries);
    return {
      embeddingCount: parseInt(results[0].rows[0]?.cnt ?? "0", 10),
      chunkCount: parseInt(results[1].rows[0]?.cnt ?? "0", 10),
      branchChunkCount: parseInt(results[2].rows[0]?.cnt ?? "0", 10),
      branchCount: parseInt(results[3].rows[0]?.cnt ?? "0", 10),
      symbolCount: parseInt(results[4].rows[0]?.cnt ?? "0", 10),
      callEdgeCount: parseInt(results[5].rows[0]?.cnt ?? "0", 10),
    };
  }

  // ── Symbols ───────────────────────────────────────────────────────

  async upsertSymbol(symbol: SymbolData): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.t("symbols")}
         (id, file_path, name, kind, start_line, start_col, end_line, end_col, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         file_path  = EXCLUDED.file_path,
         name       = EXCLUDED.name,
         kind       = EXCLUDED.kind,
         start_line = EXCLUDED.start_line,
         start_col  = EXCLUDED.start_col,
         end_line   = EXCLUDED.end_line,
         end_col    = EXCLUDED.end_col,
         language   = EXCLUDED.language`,
      [symbol.id, symbol.filePath, symbol.name, symbol.kind,
       symbol.startLine, symbol.startCol, symbol.endLine, symbol.endCol, symbol.language]
    );
  }

  async upsertSymbolsBatch(symbols: SymbolData[], sourceId?: string): Promise<void> {
    const sid = sourceId ?? "";
    if (symbols.length === 0) return;
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const symbol of symbols) {
        await client.query(
          `INSERT INTO ${this.t("symbols")}
             (id, file_path, name, kind, start_line, start_col, end_line, end_col, language, source_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             file_path  = EXCLUDED.file_path,
             name       = EXCLUDED.name,
             kind       = EXCLUDED.kind,
             start_line = EXCLUDED.start_line,
             start_col  = EXCLUDED.start_col,
             end_line   = EXCLUDED.end_line,
             end_col    = EXCLUDED.end_col,
             language   = EXCLUDED.language,
             source_id  = EXCLUDED.source_id`,
          [symbol.id, symbol.filePath, symbol.name, symbol.kind,
           symbol.startLine, symbol.startCol, symbol.endLine, symbol.endCol, symbol.language,
           sid]
        );
      }
      await client.query("COMMIT");
    });
  }

  async getSymbolsByFile(filePath: string, sourceId?: string): Promise<SymbolData[]> {
    const pool = await this.getPool();
    if (sourceId !== undefined) {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT * FROM ${this.t("symbols")} WHERE file_path = $1 AND source_id = $2`,
        [filePath, sourceId]
      );
      return rows.map(rowToSymbolData);
    }
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.t("symbols")} WHERE file_path = $1`,
      [filePath]
    );
    return rows.map(rowToSymbolData);
  }

  async getSymbolByName(name: string, filePath: string): Promise<SymbolData | null> {
    const pool = await this.getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.t("symbols")} WHERE name = $1 AND file_path = $2 LIMIT 1`,
      [name, filePath]
    );
    return rows[0] ? rowToSymbolData(rows[0]) : null;
  }

  async getSymbolsByName(name: string): Promise<SymbolData[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.t("symbols")} WHERE name = $1`,
      [name]
    );
    return rows.map(rowToSymbolData);
  }

  async getSymbolsByNameCi(name: string): Promise<SymbolData[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.t("symbols")} WHERE lower(name) = lower($1)`,
      [name]
    );
    return rows.map(rowToSymbolData);
  }

  async deleteSymbolsByFile(filePath: string, sourceId?: string): Promise<number> {
    const pool = await this.getPool();
    if (sourceId !== undefined) {
      const { rowCount } = await pool.query(
        `DELETE FROM ${this.t("symbols")} WHERE file_path = $1 AND source_id = $2`,
        [filePath, sourceId]
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("symbols")} WHERE file_path = $1`,
      [filePath]
    );
    return rowCount ?? 0;
  }

  // ── Call edges ────────────────────────────────────────────────────

  async upsertCallEdge(edge: CallEdgeData): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.t("call_edges")}
         (id, from_symbol_id, target_name, to_symbol_id, call_type, line, col, is_resolved)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         from_symbol_id = EXCLUDED.from_symbol_id,
         target_name    = EXCLUDED.target_name,
         to_symbol_id   = EXCLUDED.to_symbol_id,
         call_type      = EXCLUDED.call_type,
         line           = EXCLUDED.line,
         col            = EXCLUDED.col,
         is_resolved    = EXCLUDED.is_resolved`,
      [edge.id, edge.fromSymbolId, edge.targetName, edge.toSymbolId ?? null,
       edge.callType, edge.line, edge.col, edge.isResolved]
    );
  }

  async upsertCallEdgesBatch(edges: CallEdgeData[], sourceId?: string): Promise<void> {
    const sid = sourceId ?? "";
    if (edges.length === 0) return;
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const edge of edges) {
        await client.query(
          `INSERT INTO ${this.t("call_edges")}
             (id, from_symbol_id, target_name, to_symbol_id, call_type, line, col, is_resolved, source_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET
             from_symbol_id = EXCLUDED.from_symbol_id,
             target_name    = EXCLUDED.target_name,
             to_symbol_id   = EXCLUDED.to_symbol_id,
             call_type      = EXCLUDED.call_type,
             line           = EXCLUDED.line,
             col            = EXCLUDED.col,
             is_resolved    = EXCLUDED.is_resolved,
             source_id      = EXCLUDED.source_id`,
          [edge.id, edge.fromSymbolId, edge.targetName, edge.toSymbolId ?? null,
           edge.callType, edge.line, edge.col, edge.isResolved, sid]
        );
      }
      await client.query("COMMIT");
    });
  }

  async getCallers(targetName: string, branch: string, sourceIds?: string[]): Promise<CallEdgeData[]> {
    const pool = await this.getPool();
    if (sourceIds && sourceIds.length > 0) {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT ce.*
         FROM ${this.t("call_edges")} ce
         JOIN ${this.t("branch_symbols")} bs ON bs.symbol_id = ce.from_symbol_id
         WHERE ce.target_name = $1 AND bs.branch = $2 AND bs.source_id = ANY($3::text[])`,
        [targetName, branch, sourceIds]
      );
      return rows.map((r) => rowToCallEdgeData(r));
    }
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT ce.*
       FROM ${this.t("call_edges")} ce
       JOIN ${this.t("branch_symbols")} bs ON bs.symbol_id = ce.from_symbol_id
       WHERE ce.target_name = $1 AND bs.branch = $2`,
      [targetName, branch]
    );
    return rows.map((r) => rowToCallEdgeData(r));
  }

  async getCallersWithContext(targetName: string, branch: string, sourceIds?: string[]): Promise<CallEdgeData[]> {
    const pool = await this.getPool();
    if (sourceIds && sourceIds.length > 0) {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT ce.*,
                s.name      AS from_symbol_name,
                s.file_path AS from_symbol_file_path
         FROM ${this.t("call_edges")} ce
         JOIN ${this.t("symbols")} s           ON s.id = ce.from_symbol_id
         JOIN ${this.t("branch_symbols")} bs   ON bs.symbol_id = ce.from_symbol_id
         WHERE ce.target_name = $1 AND bs.branch = $2 AND bs.source_id = ANY($3::text[])`,
        [targetName, branch, sourceIds]
      );
      return rows.map((r) => rowToCallEdgeData(r, true));
    }
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT ce.*,
              s.name      AS from_symbol_name,
              s.file_path AS from_symbol_file_path
       FROM ${this.t("call_edges")} ce
       JOIN ${this.t("symbols")} s           ON s.id = ce.from_symbol_id
       JOIN ${this.t("branch_symbols")} bs   ON bs.symbol_id = ce.from_symbol_id
       WHERE ce.target_name = $1 AND bs.branch = $2`,
      [targetName, branch]
    );
    return rows.map((r) => rowToCallEdgeData(r, true));
  }

  async getCallees(symbolId: string, branch: string, sourceIds?: string[]): Promise<CallEdgeData[]> {
    const pool = await this.getPool();
    if (sourceIds && sourceIds.length > 0) {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT ce.*
         FROM ${this.t("call_edges")} ce
         JOIN ${this.t("branch_symbols")} bs ON bs.symbol_id = ce.from_symbol_id
         WHERE ce.from_symbol_id = $1 AND bs.branch = $2 AND bs.source_id = ANY($3::text[])`,
        [symbolId, branch, sourceIds]
      );
      return rows.map((r) => rowToCallEdgeData(r));
    }
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT ce.*
       FROM ${this.t("call_edges")} ce
       JOIN ${this.t("branch_symbols")} bs ON bs.symbol_id = ce.from_symbol_id
       WHERE ce.from_symbol_id = $1 AND bs.branch = $2`,
      [symbolId, branch]
    );
    return rows.map((r) => rowToCallEdgeData(r));
  }

  async deleteCallEdgesByFile(filePath: string, sourceId?: string): Promise<number> {
    const pool = await this.getPool();
    if (sourceId !== undefined) {
      const { rowCount } = await pool.query(
        `DELETE FROM ${this.t("call_edges")}
         WHERE from_symbol_id IN (
           SELECT id FROM ${this.t("symbols")} WHERE file_path = $1 AND source_id = $2
         )`,
        [filePath, sourceId]
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("call_edges")}
       WHERE from_symbol_id IN (
         SELECT id FROM ${this.t("symbols")} WHERE file_path = $1
       )`,
      [filePath]
    );
    return rowCount ?? 0;
  }

  async resolveCallEdge(edgeId: string, toSymbolId: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `UPDATE ${this.t("call_edges")}
       SET to_symbol_id = $2, is_resolved = TRUE
       WHERE id = $1`,
      [edgeId, toSymbolId]
    );
  }

  // ── Branch symbols ────────────────────────────────────────────────

  async addSymbolsToBranch(branch: string, symbolIds: string[]): Promise<void> {
    if (symbolIds.length === 0) return;
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const id of symbolIds) {
        await client.query(
          `INSERT INTO ${this.t("branch_symbols")} (source_id, branch, symbol_id)
           VALUES ('', $1, $2) ON CONFLICT DO NOTHING`,
          [branch, id]
        );
      }
      await client.query("COMMIT");
    });
  }

  async addSymbolsToBranchBatch(branch: string, symbolIds: string[], sourceId?: string): Promise<void> {
    if (symbolIds.length === 0) return;
    const sid = sourceId ?? "";
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const id of symbolIds) {
        await client.query(
          `INSERT INTO ${this.t("branch_symbols")} (source_id, branch, symbol_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [sid, branch, id]
        );
      }
      await client.query("COMMIT");
    });
  }

  async getBranchSymbolIds(branch: string, sourceIds?: string[]): Promise<string[]> {
    const pool = await this.getPool();
    if (sourceIds && sourceIds.length > 0) {
      const { rows } = await pool.query<{ symbol_id: string }>(
        `SELECT symbol_id FROM ${this.t("branch_symbols")} WHERE branch = $1 AND source_id = ANY($2::text[])`,
        [branch, sourceIds]
      );
      return rows.map((r) => r.symbol_id);
    }
    const { rows } = await pool.query<{ symbol_id: string }>(
      `SELECT symbol_id FROM ${this.t("branch_symbols")} WHERE branch = $1`,
      [branch]
    );
    return rows.map((r) => r.symbol_id);
  }

  async clearBranchSymbols(branch: string, sourceId?: string): Promise<number> {
    const pool = await this.getPool();
    if (sourceId !== undefined) {
      const { rowCount } = await pool.query(
        `DELETE FROM ${this.t("branch_symbols")} WHERE branch = $1 AND source_id = $2`,
        [branch, sourceId]
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("branch_symbols")} WHERE branch = $1`,
      [branch]
    );
    return rowCount ?? 0;
  }

  async getReferencedSymbolIds(symbolIds: string[]): Promise<string[]> {
    if (symbolIds.length === 0) return [];
    const pool = await this.getPool();
    const { rows } = await pool.query<{ symbol_id: string }>(
      `SELECT DISTINCT symbol_id FROM ${this.t("branch_symbols")}
       WHERE symbol_id = ANY($1::text[])`,
      [symbolIds]
    );
    return rows.map((r) => r.symbol_id);
  }

  async deleteBranchSymbolsBySymbolIds(symbolIds: string[]): Promise<number> {
    if (symbolIds.length === 0) return 0;
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("branch_symbols")} WHERE symbol_id = ANY($1::text[])`,
      [symbolIds]
    );
    return rowCount ?? 0;
  }

  async deleteBranchSymbolsForBranch(branch: string, symbolIds: string[]): Promise<number> {
    if (symbolIds.length === 0) return 0;
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("branch_symbols")}
       WHERE branch = $1 AND symbol_id = ANY($2::text[])`,
      [branch, symbolIds]
    );
    return rowCount ?? 0;
  }

  // ── GC ────────────────────────────────────────────────────────────

  async gcOrphanSymbols(): Promise<number> {
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("symbols")} s
       WHERE NOT EXISTS (
         SELECT 1 FROM ${this.t("branch_symbols")} bs WHERE bs.symbol_id = s.id
       )`
    );
    return rowCount ?? 0;
  }

  async gcOrphanCallEdges(): Promise<number> {
    const pool = await this.getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.t("call_edges")} ce
       WHERE NOT EXISTS (
         SELECT 1 FROM ${this.t("symbols")} s WHERE s.id = ce.from_symbol_id
       )`
    );
    return rowCount ?? 0;
  }

  // ── File hashes ──────────────────────────────────────────────────

  async getFileHash(filePath: string): Promise<string | null> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ hash: string }>(
      `SELECT hash FROM ${this.t("file_hashes")} WHERE file_path = $1`,
      [filePath]
    );
    return rows[0]?.hash ?? null;
  }

  async setFileHash(filePath: string, hash: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.t("file_hashes")} (source_id, file_path, hash) VALUES ('', $1, $2)
       ON CONFLICT (source_id, file_path) DO UPDATE SET hash = EXCLUDED.hash`,
      [filePath, hash]
    );
  }

  async deleteFileHash(filePath: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `DELETE FROM ${this.t("file_hashes")} WHERE source_id = '' AND file_path = $1`,
      [filePath]
    );
  }

  async getAllFileHashes(): Promise<Map<string, string>> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ file_path: string; hash: string }>(
      `SELECT file_path, hash FROM ${this.t("file_hashes")}`
    );
    return new Map(rows.map((r) => [r.file_path, r.hash]));
  }

  async setFileHashesBatch(hashes: Map<string, string>, sourceId?: string): Promise<void> {
    if (hashes.size === 0) return;
    const sid = sourceId ?? "";
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      for (const [filePath, hash] of hashes) {
        await client.query(
          `INSERT INTO ${this.t("file_hashes")} (source_id, file_path, hash) VALUES ($1, $2, $3)
           ON CONFLICT (source_id, file_path) DO UPDATE SET hash = EXCLUDED.hash`,
          [sid, filePath, hash]
        );
      }
      await client.query("COMMIT");
    });
  }

  async deleteFileHashesBatch(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    const pool = await this.getPool();
    await pool.query(
      `DELETE FROM ${this.t("file_hashes")} WHERE file_path = ANY($1::text[])`,
      [filePaths]
    );
  }

  // ── Indexing lock (PostgreSQL advisory locks) ─────────────────────

  async tryAcquireLock(pid: number, startedAt: string): Promise<boolean> {
    const pool = await this.getPool();
    const lockKey = this.t("indexing_lock");
    const { rows } = await pool.query<{ result: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS result`,
      [lockKey]
    );
    if (!rows[0]?.result) return false;
    // Store metadata so isLocked() and recovery can see who holds it.
    await pool.query(
      `INSERT INTO ${this.t("metadata")} (key, value) VALUES ('indexing_lock', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ pid, startedAt })]
    );
    return true;
  }

  async releaseLock(): Promise<void> {
    const pool = await this.getPool();
    const lockKey = this.t("indexing_lock");
    await pool.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
    await pool.query(
      `DELETE FROM ${this.t("metadata")} WHERE key = 'indexing_lock'`
    );
  }

  async isLocked(): Promise<boolean> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM ${this.t("metadata")} WHERE key = 'indexing_lock'`
    );
    return rows.length > 0;
  }

  async getLockInfo(): Promise<{ pid: number; startedAt: string } | null> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM ${this.t("metadata")} WHERE key = 'indexing_lock'`
    );
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].value) as { pid: number; startedAt: string };
    } catch {
      return null;
    }
  }

  // ── Inverted index (structured tables + SQL BM25) ────────────────

  /**
   * No-op for pgvector: posting tables are kept current by
   * upsertInvertedIndexChunkBatch / deleteInvertedIndexChunkBatch as each
   * chunk is processed, so there is nothing to bulk-sync at run end.
   * The json argument (from the in-memory Rust struct) is intentionally ignored.
   */
  async saveInvertedIndex(_json: string): Promise<void> {}

  /** For pgvector, always skip loading the Rust in-memory struct — SQL BM25 is used for search. */
  async loadInvertedIndex(): Promise<string | null> {
    return null;
  }

  async upsertInvertedIndexChunkBatch(entries: Array<{ chunkId: string; content: string }>): Promise<void> {
    if (entries.length === 0) return;

    const postingRows: Array<[string, string, number]> = [];
    const docLengthRows: Array<[string, number]> = [];

    for (const { chunkId, content } of entries) {
      const termCounts = new Map<string, number>();
      for (const term of tokenizeText(content)) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      }
      let docLen = 0;
      for (const [term, count] of termCounts) {
        postingRows.push([term, chunkId, count]);
        docLen += count;
      }
      docLengthRows.push([chunkId, docLen]);
    }

    const BATCH = 500;
    const pool = await this.getPool();

    // Upsert doc lengths
    for (let i = 0; i < docLengthRows.length; i += BATCH) {
      const slice = docLengthRows.slice(i, i + BATCH);
      const placeholders = slice.map((_, j) => `($${j * 2 + 1},$${j * 2 + 2})`).join(",");
      await pool.query(
        `INSERT INTO ${this.t("inverted_index_doc_lengths")} (chunk_id, doc_len) VALUES ${placeholders}
         ON CONFLICT (chunk_id) DO UPDATE SET doc_len = EXCLUDED.doc_len`,
        slice.flat()
      );
    }

    // Delete old postings for these chunks, then insert fresh ones
    const chunkIds = entries.map(e => e.chunkId);
    for (let i = 0; i < chunkIds.length; i += BATCH) {
      const slice = chunkIds.slice(i, i + BATCH);
      const placeholders = slice.map((_, j) => `$${j + 1}`).join(",");
      await pool.query(
        `DELETE FROM ${this.t("inverted_index_postings")} WHERE chunk_id IN (${placeholders})`,
        slice
      );
    }
    for (let i = 0; i < postingRows.length; i += BATCH) {
      const slice = postingRows.slice(i, i + BATCH);
      const placeholders = slice.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`).join(",");
      await pool.query(
        `INSERT INTO ${this.t("inverted_index_postings")} (term, chunk_id, token_count) VALUES ${placeholders}`,
        slice.flat()
      );
    }
  }

  async deleteInvertedIndexChunkBatch(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const pool = await this.getPool();
    const BATCH = 500;
    for (let i = 0; i < chunkIds.length; i += BATCH) {
      const slice = chunkIds.slice(i, i + BATCH);
      const placeholders = slice.map((_, j) => `$${j + 1}`).join(",");
      await pool.query(
        `DELETE FROM ${this.t("inverted_index_postings")} WHERE chunk_id IN (${placeholders})`,
        slice
      );
      await pool.query(
        `DELETE FROM ${this.t("inverted_index_doc_lengths")} WHERE chunk_id IN (${placeholders})`,
        slice
      );
    }
  }

  async searchBm25(query: string, limit: number, sourceIds?: string[]): Promise<Map<string, number> | null> {
    const terms = tokenizeText(query);
    if (terms.length === 0) return new Map();

    const pool = await this.getPool();
    let queryText: string;
    let params: unknown[];

    if (sourceIds && sourceIds.length > 0) {
      // Scope BM25 corpus stats and results to the given sources by joining chunks.
      queryText = `WITH
        qt AS (SELECT UNNEST($1::text[]) AS term),
        src_chunks AS (
          SELECT chunk_id FROM ${this.t("chunks")} WHERE source_id = ANY($3::text[])
        ),
        tdf AS (
          SELECT p.term, COUNT(DISTINCT p.chunk_id)::FLOAT AS df
          FROM ${this.t("inverted_index_postings")} p
          JOIN src_chunks sc ON p.chunk_id = sc.chunk_id
          JOIN qt ON p.term = qt.term
          GROUP BY p.term
        ),
        stats AS (
          SELECT
            COUNT(*)::FLOAT                      AS total_docs,
            COALESCE(AVG(dl.doc_len)::FLOAT, 1.0) AS avg_dl
          FROM ${this.t("inverted_index_doc_lengths")} dl
          JOIN src_chunks sc ON dl.chunk_id = sc.chunk_id
        ),
        scored AS (
          SELECT
            p.chunk_id,
            SUM(
              LN((s.total_docs - t.df + 0.5) / (t.df + 0.5) + 1.0)
              * (p.token_count::FLOAT * 2.2)
              / (p.token_count::FLOAT + 1.2 * (0.25 + 0.75 * dl.doc_len::FLOAT / s.avg_dl))
            ) AS score
          FROM ${this.t("inverted_index_postings")} p
          JOIN src_chunks sc                              ON p.chunk_id = sc.chunk_id
          JOIN qt                                         ON p.term     = qt.term
          JOIN tdf t                                      ON p.term     = t.term
          JOIN ${this.t("inverted_index_doc_lengths")} dl ON p.chunk_id = dl.chunk_id
          CROSS JOIN stats s
          GROUP BY p.chunk_id
        )
      SELECT chunk_id, score FROM scored ORDER BY score DESC LIMIT $2`;
      params = [terms, limit, sourceIds];
    } else {
      queryText = `WITH
        qt AS (SELECT UNNEST($1::text[]) AS term),
        tdf AS (
          SELECT p.term, COUNT(DISTINCT p.chunk_id)::FLOAT AS df
          FROM ${this.t("inverted_index_postings")} p
          JOIN qt ON p.term = qt.term
          GROUP BY p.term
        ),
        stats AS (
          SELECT
            COUNT(*)::FLOAT                                         AS total_docs,
            COALESCE(AVG(doc_len)::FLOAT, 1.0)                     AS avg_dl
          FROM ${this.t("inverted_index_doc_lengths")}
        ),
        scored AS (
          SELECT
            p.chunk_id,
            SUM(
              LN((s.total_docs - t.df + 0.5) / (t.df + 0.5) + 1.0)
              * (p.token_count::FLOAT * 2.2)
              / (p.token_count::FLOAT + 1.2 * (0.25 + 0.75 * dl.doc_len::FLOAT / s.avg_dl))
            ) AS score
          FROM ${this.t("inverted_index_postings")} p
          JOIN qt                                          ON p.term     = qt.term
          JOIN tdf t                                       ON p.term     = t.term
          JOIN ${this.t("inverted_index_doc_lengths")} dl ON p.chunk_id = dl.chunk_id
          CROSS JOIN stats s
          GROUP BY p.chunk_id
        )
      SELECT chunk_id, score FROM scored ORDER BY score DESC LIMIT $2`;
      params = [terms, limit];
    }

    const { rows } = await pool.query<{ chunk_id: string; score: number }>(queryText, params);
    const result = new Map<string, number>();
    for (const row of rows) result.set(row.chunk_id, Number(row.score));
    return result;
  }

  // ── Bulk file-hash replacement ────────────────────────────────────

  async replaceAllFileHashes(hashes: Map<string, string>, sourceId?: string): Promise<void> {
    const sid = sourceId ?? "";
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM ${this.t("file_hashes")} WHERE source_id = $1`,
        [sid]
      );
      for (const [filePath, hash] of hashes) {
        await client.query(
          `INSERT INTO ${this.t("file_hashes")} (source_id, file_path, hash) VALUES ($1, $2, $3)`,
          [sid, filePath, hash]
        );
      }
      await client.query("COMMIT");
    });
  }

  async getFileHashBatch(filePaths: string[], sourceId?: string): Promise<Map<string, string>> {
    if (filePaths.length === 0) return new Map();
    const pool = await this.getPool();
    const sid = sourceId ?? "";
    const { rows } = await pool.query<{ file_path: string; hash: string }>(
      `SELECT file_path, hash FROM ${this.t("file_hashes")}
       WHERE source_id = $1 AND file_path = ANY($2::text[])`,
      [sid, filePaths]
    );
    return new Map(rows.map((r) => [r.file_path, r.hash]));
  }

  async hasSourcesOtherThan(sourceIds: string[]): Promise<boolean> {
    if (sourceIds.length === 0) {
      const pool = await this.getPool();
      const { rows } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM ${this.t("file_hashes")}`
      );
      return parseInt(rows[0]?.cnt ?? "0", 10) > 0;
    }
    const pool = await this.getPool();
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM ${this.t("file_hashes")}
         WHERE source_id != ALL($1::text[])
       ) AS exists`,
      [sourceIds]
    );
    return rows[0]?.exists ?? false;
  }

  async getFilePathsBySource(sourceId: string): Promise<string[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query<{ file_path: string }>(
      `SELECT file_path FROM ${this.t("file_hashes")} WHERE source_id = $1`,
      [sourceId]
    );
    return rows.map((r) => r.file_path);
  }

  async deleteFileHashesBySource(sourceId: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `DELETE FROM ${this.t("file_hashes")} WHERE source_id = $1`,
      [sourceId]
    );
  }
}
