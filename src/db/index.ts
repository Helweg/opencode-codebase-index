/**
 * Factory functions for creating database and vector-store backend instances.
 *
 * Callers should use these instead of constructing backends directly so that
 * the correct implementation is selected based on the active configuration.
 */

import * as path from "path";
import type { DatabaseConfig } from "../config/schema.js";
import type { IDatabaseBackend, IVectorStoreBackend } from "./backend.js";
import { SqliteDatabaseBackend, SqliteVectorStoreBackend } from "./sqlite-backend.js";
import { PgDatabaseBackend, PgVectorStoreBackend } from "./pg-backend.js";

export type { IDatabaseBackend, IVectorStoreBackend };
export type { VectorSearchResult } from "./backend.js";
export { SqliteDatabaseBackend, SqliteVectorStoreBackend } from "./sqlite-backend.js";
export { PgDatabaseBackend, PgVectorStoreBackend } from "./pg-backend.js";

// ── Database backend factory ─────────────────────────────────────────────────

/**
 * Create an IDatabaseBackend for the given config.
 *
 * @param config  The resolved DatabaseConfig from parseConfig().
 * @param dbPath  Absolute path for the SQLite file (ignored for pgvector).
 */
export async function createDatabaseBackend(
  config: DatabaseConfig,
  dbPath: string
): Promise<IDatabaseBackend> {
  if (config.engine === "pgvector") {
    if (!config.pgvector) {
      throw new Error(
        "[codebase-index] database.engine is 'pgvector' but no database.pgvector config was provided"
      );
    }
    const backend = new PgDatabaseBackend(config.pgvector);
    await backend.initialize();
    return backend;
  }

  // Default: SQLite
  const backend = new SqliteDatabaseBackend(dbPath);
  await backend.initialize();
  return backend;
}

// ── Vector store backend factory ─────────────────────────────────────────────

/**
 * Create an IVectorStoreBackend for the given config.
 *
 * @param config      The resolved DatabaseConfig from parseConfig().
 * @param storePath   Base path for the usearch vector file (ignored for pgvector).
 * @param dimensions  Embedding dimensions (must match the chosen model).
 */
export async function createVectorStoreBackend(
  config: DatabaseConfig,
  storePath: string,
  dimensions: number
): Promise<IVectorStoreBackend> {
  if (config.engine === "pgvector") {
    if (!config.pgvector) {
      throw new Error(
        "[codebase-index] database.engine is 'pgvector' but no database.pgvector config was provided"
      );
    }
    const backend = new PgVectorStoreBackend(config.pgvector);
    await backend.initialize(dimensions);
    return backend;
  }

  // Default: SQLite / usearch
  const vectorPath = path.join(storePath, "vectors");
  const backend = new SqliteVectorStoreBackend(vectorPath);
  await backend.initialize(dimensions);
  return backend;
}
