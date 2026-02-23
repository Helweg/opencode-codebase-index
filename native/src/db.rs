use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub type DbResult<T> = Result<T, DbError>;

/// Schema version for migrations
const SCHEMA_VERSION: i32 = 1;

/// Maximum number of SQL bind parameters per query.
/// SQLite defaults to 999 (SQLITE_MAX_VARIABLE_NUMBER). We use 900 to stay safely under.
const SQL_BIND_PARAM_BATCH_SIZE: usize = 900;

/// Initialize the database with the required schema
pub fn init_db(db_path: &Path) -> DbResult<Connection> {
    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let conn = Connection::open(db_path)?;

    // Enable WAL mode for better concurrent read performance
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

    let current_version: i32 = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None)
        .and_then(|v: String| v.parse().ok())
        .unwrap_or(0);

    if current_version < SCHEMA_VERSION {
        migrate_schema(&conn, current_version)?;
    }

    Ok(conn)
}

/// Run schema migrations
fn migrate_schema(conn: &Connection, from_version: i32) -> DbResult<()> {
    if from_version < 1 {
        // Initial schema
        conn.execute_batch(
            r#"
            -- Metadata table (must be created first for schema_version)
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Embeddings stored by content hash (deduplicated across branches)
            CREATE TABLE IF NOT EXISTS embeddings (
                content_hash TEXT PRIMARY KEY,
                embedding BLOB NOT NULL,
                chunk_text TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            -- Chunks table: stores chunk metadata
            CREATE TABLE IF NOT EXISTS chunks (
                chunk_id TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL,
                file_path TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                node_type TEXT,
                name TEXT,
                language TEXT NOT NULL
            );

            -- Branch catalog: which chunks exist on which branch
            CREATE TABLE IF NOT EXISTS branch_chunks (
                branch TEXT NOT NULL,
                chunk_id TEXT NOT NULL,
                PRIMARY KEY (branch, chunk_id)
            );

            -- Indexes for fast lookups
            CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
            CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
            CREATE INDEX IF NOT EXISTS idx_branch_chunks_branch ON branch_chunks(branch);
            CREATE INDEX IF NOT EXISTS idx_branch_chunks_chunk_id ON branch_chunks(chunk_id);
            "#,
        )?;

        // Set schema version
        conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)",
            params![SCHEMA_VERSION.to_string()],
        )?;
    }

    Ok(())
}

// ============================================================================
// Embedding Operations
// ============================================================================

/// Check if an embedding exists for a content hash
pub fn embedding_exists(conn: &Connection, content_hash: &str) -> DbResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM embeddings WHERE content_hash = ?",
        params![content_hash],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Get embedding for a content hash
pub fn get_embedding(conn: &Connection, content_hash: &str) -> DbResult<Option<Vec<u8>>> {
    let result = conn
        .query_row(
            "SELECT embedding FROM embeddings WHERE content_hash = ?",
            params![content_hash],
            |row| row.get(0),
        )
        .optional()?;
    Ok(result)
}

/// Insert or update an embedding
pub fn upsert_embedding(
    conn: &Connection,
    content_hash: &str,
    embedding: &[u8],
    chunk_text: &str,
    model: &str,
) -> DbResult<()> {
    conn.execute(
        r#"
        INSERT INTO embeddings (content_hash, embedding, chunk_text, model, created_at)
        VALUES (?, ?, ?, ?, strftime('%s', 'now'))
        ON CONFLICT(content_hash) DO UPDATE SET
            embedding = excluded.embedding,
            model = excluded.model
        "#,
        params![content_hash, embedding, chunk_text, model],
    )?;
    Ok(())
}

/// Batch insert or update embeddings within a single transaction
pub fn upsert_embeddings_batch(
    conn: &mut Connection,
    embeddings: &[(String, Vec<u8>, String, String)],
) -> DbResult<()> {
    if embeddings.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            r#"
            INSERT INTO embeddings (content_hash, embedding, chunk_text, model, created_at)
            VALUES (?, ?, ?, ?, strftime('%s', 'now'))
            ON CONFLICT(content_hash) DO UPDATE SET
                embedding = excluded.embedding,
                model = excluded.model
            "#,
        )?;

        for (content_hash, embedding, chunk_text, model) in embeddings {
            stmt.execute(params![content_hash, embedding, chunk_text, model])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Get multiple embeddings by content hashes
#[allow(dead_code)]
pub fn get_embeddings_batch(
    conn: &Connection,
    content_hashes: &[String],
) -> DbResult<Vec<(String, Vec<u8>)>> {
    if content_hashes.is_empty() {
        return Ok(vec![]);
    }
    let mut results = Vec::new();
    for chunk in content_hashes.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders: String = chunk
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let query = format!(
            "SELECT content_hash, embedding FROM embeddings WHERE content_hash IN ({})",
            placeholders
        );

        let mut stmt = conn.prepare(&query)?;
        let params: Vec<&dyn rusqlite::ToSql> = chunk
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();

        let rows = stmt.query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;

        for row in rows {
            results.push(row?);
        }
    }
    Ok(results)
}

/// Get content hashes that don't have embeddings yet
pub fn get_missing_embeddings(
    conn: &Connection,
    content_hashes: &[String],
) -> DbResult<Vec<String>> {
    if content_hashes.is_empty() {
        return Ok(vec![]);
    }
    let mut existing = std::collections::HashSet::new();
    for chunk in content_hashes.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders: String = chunk
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let query = format!(
            "SELECT content_hash FROM embeddings WHERE content_hash IN ({})",
            placeholders
        );

        let mut stmt = conn.prepare(&query)?;
        let params: Vec<&dyn rusqlite::ToSql> = chunk
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();

        let batch_existing: std::collections::HashSet<String> = stmt
            .query_map(params.as_slice(), |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        
        existing.extend(batch_existing);
    }

    Ok(content_hashes
        .iter()
        .filter(|h| !existing.contains(*h))
        .cloned()
        .collect())
}

// ============================================================================
// Chunk Operations
// ============================================================================

/// Insert or update a chunk
#[allow(clippy::too_many_arguments)]
pub fn upsert_chunk(
    conn: &Connection,
    chunk_id: &str,
    content_hash: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    node_type: Option<&str>,
    name: Option<&str>,
    language: &str,
) -> DbResult<()> {
    conn.execute(
        r#"
        INSERT INTO chunks (chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET
            content_hash = excluded.content_hash,
            file_path = excluded.file_path,
            start_line = excluded.start_line,
            end_line = excluded.end_line,
            node_type = excluded.node_type,
            name = excluded.name,
            language = excluded.language
        "#,
        params![chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language],
    )?;
    Ok(())
}

/// Batch insert or update chunks within a single transaction
pub fn upsert_chunks_batch(conn: &mut Connection, chunks: &[ChunkRow]) -> DbResult<()> {
    if chunks.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            r#"
            INSERT INTO chunks (chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chunk_id) DO UPDATE SET
                content_hash = excluded.content_hash,
                file_path = excluded.file_path,
                start_line = excluded.start_line,
                end_line = excluded.end_line,
                node_type = excluded.node_type,
                name = excluded.name,
                language = excluded.language
            "#,
        )?;

        for chunk in chunks {
            stmt.execute(params![
                chunk.chunk_id,
                chunk.content_hash,
                chunk.file_path,
                chunk.start_line,
                chunk.end_line,
                chunk.node_type,
                chunk.name,
                chunk.language
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Get chunk by ID
pub fn get_chunk(conn: &Connection, chunk_id: &str) -> DbResult<Option<ChunkRow>> {
    let result = conn
        .query_row(
            r#"
            SELECT chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language
            FROM chunks WHERE chunk_id = ?
            "#,
            params![chunk_id],
            |row| {
                Ok(ChunkRow {
                    chunk_id: row.get(0)?,
                    content_hash: row.get(1)?,
                    file_path: row.get(2)?,
                    start_line: row.get(3)?,
                    end_line: row.get(4)?,
                    node_type: row.get(5)?,
                    name: row.get(6)?,
                    language: row.get(7)?,
                })
            },
        )
        .optional()?;
    Ok(result)
}

/// Get all chunks for a file
pub fn get_chunks_by_file(conn: &Connection, file_path: &str) -> DbResult<Vec<ChunkRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language
        FROM chunks WHERE file_path = ?
        ORDER BY start_line
        "#,
    )?;

    let rows = stmt.query_map(params![file_path], |row| {
        Ok(ChunkRow {
            chunk_id: row.get(0)?,
            content_hash: row.get(1)?,
            file_path: row.get(2)?,
            start_line: row.get(3)?,
            end_line: row.get(4)?,
            node_type: row.get(5)?,
            name: row.get(6)?,
            language: row.get(7)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Delete chunks for a file
pub fn delete_chunks_by_file(conn: &Connection, file_path: &str) -> DbResult<usize> {
    let count = conn.execute("DELETE FROM chunks WHERE file_path = ?", params![file_path])?;
    Ok(count)
}

#[derive(Debug, Clone)]
pub struct ChunkRow {
    pub chunk_id: String,
    pub content_hash: String,
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub node_type: Option<String>,
    pub name: Option<String>,
    pub language: String,
}

// ============================================================================
// Branch Catalog Operations
// ============================================================================

/// Add chunks to a branch
pub fn add_chunks_to_branch(conn: &Connection, branch: &str, chunk_ids: &[String]) -> DbResult<()> {
    if chunk_ids.is_empty() {
        return Ok(());
    }

    let mut stmt =
        conn.prepare("INSERT OR IGNORE INTO branch_chunks (branch, chunk_id) VALUES (?, ?)")?;

    for chunk_id in chunk_ids {
        stmt.execute(params![branch, chunk_id])?;
    }
    Ok(())
}

/// Batch add chunks to a branch within a single transaction
pub fn add_chunks_to_branch_batch(
    conn: &mut Connection,
    branch: &str,
    chunk_ids: &[String],
) -> DbResult<()> {
    if chunk_ids.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut stmt =
            tx.prepare("INSERT OR IGNORE INTO branch_chunks (branch, chunk_id) VALUES (?, ?)")?;

        for chunk_id in chunk_ids {
            stmt.execute(params![branch, chunk_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Remove all chunks from a branch (for re-indexing)
pub fn clear_branch(conn: &Connection, branch: &str) -> DbResult<usize> {
    let count = conn.execute(
        "DELETE FROM branch_chunks WHERE branch = ?",
        params![branch],
    )?;
    Ok(count)
}

/// Get all chunk IDs for a branch
pub fn get_branch_chunk_ids(conn: &Connection, branch: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT chunk_id FROM branch_chunks WHERE branch = ?")?;
    let rows = stmt.query_map(params![branch], |row| row.get::<_, String>(0))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Get chunks that exist on branch A but not on branch B (delta)
pub fn get_branch_delta(
    conn: &Connection,
    branch: &str,
    base_branch: &str,
) -> DbResult<BranchDelta> {
    // Chunks added (on branch but not on base)
    let mut added_stmt = conn.prepare(
        r#"
        SELECT bc.chunk_id FROM branch_chunks bc
        WHERE bc.branch = ?
        AND bc.chunk_id NOT IN (
            SELECT chunk_id FROM branch_chunks WHERE branch = ?
        )
        "#,
    )?;
    let added: Vec<String> = added_stmt
        .query_map(params![branch, base_branch], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    // Chunks removed (on base but not on branch)
    let mut removed_stmt = conn.prepare(
        r#"
        SELECT bc.chunk_id FROM branch_chunks bc
        WHERE bc.branch = ?
        AND bc.chunk_id NOT IN (
            SELECT chunk_id FROM branch_chunks WHERE branch = ?
        )
        "#,
    )?;
    let removed: Vec<String> = removed_stmt
        .query_map(params![base_branch, branch], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(BranchDelta { added, removed })
}

#[derive(Debug, Clone)]
pub struct BranchDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

/// Check if a chunk exists on a branch
pub fn chunk_exists_on_branch(conn: &Connection, branch: &str, chunk_id: &str) -> DbResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM branch_chunks WHERE branch = ? AND chunk_id = ?",
        params![branch, chunk_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Get all branches
pub fn get_all_branches(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT branch FROM branch_chunks")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

// ============================================================================
// Metadata Operations
// ============================================================================

/// Get a metadata value
pub fn get_metadata(conn: &Connection, key: &str) -> DbResult<Option<String>> {
    let result = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = ?",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(result)
}

/// Set a metadata value
pub fn set_metadata(conn: &Connection, key: &str, value: &str) -> DbResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

/// Delete a metadata value
pub fn delete_metadata(conn: &Connection, key: &str) -> DbResult<bool> {
    let count = conn.execute("DELETE FROM metadata WHERE key = ?", params![key])?;
    Ok(count > 0)
}

// ============================================================================
// Garbage Collection
// ============================================================================

/// Delete orphaned embeddings (not referenced by any chunk)
pub fn gc_orphan_embeddings(conn: &Connection) -> DbResult<usize> {
    let count = conn.execute(
        r#"
        DELETE FROM embeddings
        WHERE content_hash NOT IN (
            SELECT DISTINCT content_hash FROM chunks
        )
        "#,
        [],
    )?;
    Ok(count)
}

/// Delete orphaned chunks (not referenced by any branch)
pub fn gc_orphan_chunks(conn: &Connection) -> DbResult<usize> {
    let count = conn.execute(
        r#"
        DELETE FROM chunks
        WHERE chunk_id NOT IN (
            SELECT DISTINCT chunk_id FROM branch_chunks
        )
        "#,
        [],
    )?;
    Ok(count)
}

/// Get database statistics
pub fn get_stats(conn: &Connection) -> DbResult<DbStats> {
    let embedding_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get(0))?;
    let chunk_count: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;
    let branch_chunk_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM branch_chunks", [], |row| row.get(0))?;
    let branch_count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT branch) FROM branch_chunks",
        [],
        |row| row.get(0),
    )?;

    Ok(DbStats {
        embedding_count: embedding_count as u64,
        chunk_count: chunk_count as u64,
        branch_chunk_count: branch_chunk_count as u64,
        branch_count: branch_count as u64,
    })
}

#[derive(Debug, Clone)]
pub struct DbStats {
    pub embedding_count: u64,
    pub chunk_count: u64,
    pub branch_chunk_count: u64,
    pub branch_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, Connection) {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let conn = init_db(&db_path).unwrap();
        (temp_dir, conn)
    }

    #[test]
    fn test_init_db() {
        let (_temp_dir, conn) = setup_test_db();
        let version: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, "1");
    }

    #[test]
    fn test_embedding_operations() {
        let (_temp_dir, conn) = setup_test_db();

        // Insert embedding
        let hash = "abc123";
        let embedding = vec![1u8, 2, 3, 4];
        upsert_embedding(&conn, hash, &embedding, "test content", "test-model").unwrap();

        // Check exists
        assert!(embedding_exists(&conn, hash).unwrap());
        assert!(!embedding_exists(&conn, "nonexistent").unwrap());

        // Get embedding
        let retrieved = get_embedding(&conn, hash).unwrap().unwrap();
        assert_eq!(retrieved, embedding);
    }

    #[test]
    fn test_chunk_operations() {
        let (_temp_dir, conn) = setup_test_db();

        // First insert the embedding
        upsert_embedding(&conn, "hash1", &[1, 2, 3], "content", "model").unwrap();

        // Insert chunk
        upsert_chunk(
            &conn,
            "chunk1",
            "hash1",
            "src/main.rs",
            10,
            20,
            Some("function"),
            Some("main"),
            "rust",
        )
        .unwrap();

        // Get chunk
        let chunk = get_chunk(&conn, "chunk1").unwrap().unwrap();
        assert_eq!(chunk.file_path, "src/main.rs");
        assert_eq!(chunk.start_line, 10);
        assert_eq!(chunk.node_type, Some("function".to_string()));
    }

    #[test]
    fn test_branch_operations() {
        let (_temp_dir, conn) = setup_test_db();

        // Setup
        upsert_embedding(&conn, "hash1", &[1], "c1", "m").unwrap();
        upsert_embedding(&conn, "hash2", &[2], "c2", "m").unwrap();
        upsert_embedding(&conn, "hash3", &[3], "c3", "m").unwrap();

        upsert_chunk(&conn, "c1", "hash1", "f1.rs", 1, 10, None, None, "rust").unwrap();
        upsert_chunk(&conn, "c2", "hash2", "f2.rs", 1, 10, None, None, "rust").unwrap();
        upsert_chunk(&conn, "c3", "hash3", "f3.rs", 1, 10, None, None, "rust").unwrap();

        // Add to branches
        add_chunks_to_branch(&conn, "main", &["c1".to_string(), "c2".to_string()]).unwrap();
        add_chunks_to_branch(&conn, "feature", &["c1".to_string(), "c3".to_string()]).unwrap();

        // Get branch chunks
        let main_chunks = get_branch_chunk_ids(&conn, "main").unwrap();
        assert_eq!(main_chunks.len(), 2);

        // Get delta
        let delta = get_branch_delta(&conn, "feature", "main").unwrap();
        assert_eq!(delta.added, vec!["c3".to_string()]);
        assert_eq!(delta.removed, vec!["c2".to_string()]);
    }

    #[test]
    fn test_garbage_collection() {
        let (_temp_dir, conn) = setup_test_db();

        // Create orphaned embedding
        upsert_embedding(&conn, "orphan", &[1], "orphan content", "m").unwrap();
        upsert_embedding(&conn, "used", &[2], "used content", "m").unwrap();

        // Create chunk using one embedding
        upsert_chunk(&conn, "c1", "used", "f1.rs", 1, 10, None, None, "rust").unwrap();
        add_chunks_to_branch(&conn, "main", &["c1".to_string()]).unwrap();

        // GC should remove orphan
        let removed = gc_orphan_embeddings(&conn).unwrap();
        assert_eq!(removed, 1);

        assert!(!embedding_exists(&conn, "orphan").unwrap());
        assert!(embedding_exists(&conn, "used").unwrap());
    }
}