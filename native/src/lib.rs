#![deny(clippy::all)]

mod chunker;
mod db;
mod hasher;
mod inverted_index;
mod parser;
mod store;
mod types;
mod call_extractor;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;

pub use chunker::*;
pub use hasher::*;
pub use inverted_index::*;
pub use parser::*;
pub use store::*;
pub use types::*;

#[napi]
pub fn parse_file(file_path: String, content: String) -> Result<Vec<CodeChunk>> {
    parser::parse_file_internal(&file_path, &content).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_files(files: Vec<FileInput>) -> Result<Vec<ParsedFile>> {
    parser::parse_files_parallel(files).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn hash_content(content: String) -> String {
    hasher::xxhash_content(&content)
}

#[napi]
pub fn hash_file(file_path: String) -> Result<String> {
    hasher::xxhash_file(&file_path).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn extract_calls(content: String, language: String) -> Result<Vec<CallSiteData>> {
    call_extractor::extract_calls(&content, &language)
        .map(|sites| {
            sites
                .into_iter()
                .map(|s| CallSiteData {
                    callee_name: s.callee_name,
                    line: s.line,
                    column: s.column,
                    call_type: format!("{:?}", s.call_type),
                })
                .collect()
        })
        .map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub struct VectorStore {
    inner: store::VectorStoreInner,
}

#[napi]
impl VectorStore {
    #[napi(constructor)]
    pub fn new(index_path: String, dimensions: u32) -> Result<Self> {
        let inner = store::VectorStoreInner::new(PathBuf::from(index_path), dimensions as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self { inner })
    }

    #[napi]
    pub fn add(&mut self, id: String, vector: Vec<f64>, metadata: String) -> Result<()> {
        let vector_f32: Vec<f32> = vector.iter().map(|&x| x as f32).collect();
        self.inner
            .add(&id, &vector_f32, &metadata)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_batch(
        &mut self,
        ids: Vec<String>,
        vectors: Vec<Vec<f64>>,
        metadata: Vec<String>,
    ) -> Result<()> {
        let vectors_f32: Vec<Vec<f32>> = vectors
            .iter()
            .map(|v| v.iter().map(|&x| x as f32).collect())
            .collect();
        self.inner
            .add_batch(&ids, &vectors_f32, &metadata)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn search(&self, query_vector: Vec<f64>, limit: u32) -> Result<Vec<SearchResult>> {
        let query_f32: Vec<f32> = query_vector.iter().map(|&x| x as f32).collect();
        self.inner
            .search(&query_f32, limit as usize)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn remove(&mut self, id: String) -> Result<bool> {
        self.inner
            .remove(&id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn save(&self) -> Result<()> {
        self.inner
            .save()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn load(&mut self) -> Result<()> {
        self.inner
            .load()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn count(&self) -> u32 {
        self.inner.count() as u32
    }

    #[napi]
    pub fn clear(&mut self) -> Result<()> {
        self.inner
            .clear()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_all_keys(&self) -> Vec<String> {
        self.inner.get_all_keys()
    }

    #[napi]
    pub fn get_all_metadata(&self) -> Vec<KeyMetadataPair> {
        self.inner
            .get_all_metadata()
            .into_iter()
            .map(|(key, metadata)| KeyMetadataPair { key, metadata })
            .collect()
    }

    #[napi]
    pub fn get_metadata(&self, id: String) -> Option<String> {
        self.inner.get_metadata(&id)
    }

    #[napi]
    pub fn get_metadata_batch(&self, ids: Vec<String>) -> Vec<KeyMetadataPair> {
        self.inner
            .get_metadata_batch(&ids)
            .into_iter()
            .map(|(key, metadata)| KeyMetadataPair { key, metadata })
            .collect()
    }
}

#[napi(object)]
pub struct FileInput {
    pub path: String,
    pub content: String,
}

#[napi(object)]
pub struct ParsedFile {
    pub path: String,
    pub chunks: Vec<CodeChunk>,
    pub hash: String,
}

#[napi(object)]
pub struct CodeChunk {
    pub content: String,
    pub start_line: u32,
    pub end_line: u32,
    pub chunk_type: String,
    pub name: Option<String>,
    pub language: String,
}

#[napi(object)]
pub struct SearchResult {
    pub id: String,
    pub score: f64,
    pub metadata: String,
}

#[napi(object)]
pub struct KeyMetadataPair {
    pub key: String,
    pub metadata: String,
}

#[napi(object)]
pub struct CallSiteData {
    pub callee_name: String,
    pub line: u32,
    pub column: u32,
    pub call_type: String,
}

#[napi(object)]
pub struct SymbolData {
    pub id: String,
    pub file_path: String,
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub language: String,
}

#[napi(object)]
pub struct CallEdgeData {
    pub id: String,
    pub from_symbol_id: String,
    pub target_name: String,
    pub to_symbol_id: Option<String>,
    pub call_type: String,
    pub line: u32,
    pub col: u32,
    pub is_resolved: bool,
}

#[napi(object)]
pub struct KeywordSearchResult {
    pub chunk_id: String,
    pub score: f64,
}

#[napi]
pub struct InvertedIndex {
    inner: inverted_index::InvertedIndexInner,
}

#[napi]
impl InvertedIndex {
    #[napi(constructor)]
    pub fn new(index_path: String) -> Self {
        let inner = inverted_index::InvertedIndexInner::new(PathBuf::from(index_path));
        Self { inner }
    }

    #[napi]
    pub fn load(&mut self) -> Result<()> {
        self.inner
            .load()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn save(&self) -> Result<()> {
        self.inner
            .save()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_chunk(&mut self, chunk_id: String, content: String) {
        self.inner.add_chunk(&chunk_id, &content);
    }

    #[napi]
    pub fn remove_chunk(&mut self, chunk_id: String) -> bool {
        self.inner.remove_chunk(&chunk_id)
    }

    #[napi]
    pub fn search(&self, query: String, limit: Option<u32>) -> Vec<KeywordSearchResult> {
        let results = self.inner.search(&query);
        let limit = limit.unwrap_or(100) as usize;
        results
            .into_iter()
            .take(limit)
            .map(|(chunk_id, score)| KeywordSearchResult { chunk_id, score })
            .collect()
    }

    #[napi]
    pub fn has_chunk(&self, chunk_id: String) -> bool {
        self.inner.has_chunk(&chunk_id)
    }

    #[napi]
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    #[napi]
    pub fn document_count(&self) -> u32 {
        self.inner.document_count() as u32
    }
}

#[napi]
pub struct Database {
    conn: std::sync::Mutex<rusqlite::Connection>,
}

#[napi(object)]
pub struct ChunkData {
    pub chunk_id: String,
    pub content_hash: String,
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub node_type: Option<String>,
    pub name: Option<String>,
    pub language: String,
}

#[napi(object)]
pub struct BranchDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[napi(object)]
pub struct EmbeddingBatchItem {
    pub content_hash: String,
    pub embedding: Buffer,
    pub chunk_text: String,
    pub model: String,
}

#[napi(object)]
pub struct DatabaseStats {
    pub embedding_count: u32,
    pub chunk_count: u32,
    pub branch_chunk_count: u32,
    pub branch_count: u32,
    pub symbol_count: u32,
    pub call_edge_count: u32,
}

#[napi]
impl Database {
    #[napi(constructor)]
    pub fn new(db_path: String) -> Result<Self> {
        let conn = db::init_db(std::path::Path::new(&db_path))
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self {
            conn: std::sync::Mutex::new(conn),
        })
    }

    #[napi]
    pub fn embedding_exists(&self, content_hash: String) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::embedding_exists(&conn, &content_hash).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_embedding(&self, content_hash: String) -> Result<Option<Buffer>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let result = db::get_embedding(&conn, &content_hash)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(result.map(Buffer::from))
    }

    #[napi]
    pub fn upsert_embedding(
        &self,
        content_hash: String,
        embedding: Buffer,
        chunk_text: String,
        model: String,
    ) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::upsert_embedding(&conn, &content_hash, &embedding, &chunk_text, &model)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_missing_embeddings(&self, content_hashes: Vec<String>) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_missing_embeddings(&conn, &content_hashes)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_chunk(&self, chunk: ChunkData) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::upsert_chunk(
            &conn,
            &chunk.chunk_id,
            &chunk.content_hash,
            &chunk.file_path,
            chunk.start_line,
            chunk.end_line,
            chunk.node_type.as_deref(),
            chunk.name.as_deref(),
            &chunk.language,
        )
        .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_chunk(&self, chunk_id: String) -> Result<Option<ChunkData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let result =
            db::get_chunk(&conn, &chunk_id).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(result.map(|row| ChunkData {
            chunk_id: row.chunk_id,
            content_hash: row.content_hash,
            file_path: row.file_path,
            start_line: row.start_line,
            end_line: row.end_line,
            node_type: row.node_type,
            name: row.name,
            language: row.language,
        }))
    }

    #[napi]
    pub fn get_chunks_by_file(&self, file_path: String) -> Result<Vec<ChunkData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_chunks_by_file(&conn, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| ChunkData {
                chunk_id: row.chunk_id,
                content_hash: row.content_hash,
                file_path: row.file_path,
                start_line: row.start_line,
                end_line: row.end_line,
                node_type: row.node_type,
                name: row.name,
                language: row.language,
            })
            .collect())
    }

    #[napi]
    pub fn delete_chunks_by_file(&self, file_path: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::delete_chunks_by_file(&conn, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn add_chunks_to_branch(&self, branch: String, chunk_ids: Vec<String>) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::add_chunks_to_branch(&conn, &branch, &chunk_ids)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_embeddings_batch(&self, items: Vec<EmbeddingBatchItem>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let batch: Vec<(String, Vec<u8>, String, String)> = items
            .into_iter()
            .map(|item| {
                (
                    item.content_hash,
                    item.embedding.to_vec(),
                    item.chunk_text,
                    item.model,
                )
            })
            .collect();
        db::upsert_embeddings_batch(&mut conn, &batch)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_chunks_batch(&self, chunks: Vec<ChunkData>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let batch: Vec<db::ChunkRow> = chunks
            .into_iter()
            .map(|c| db::ChunkRow {
                chunk_id: c.chunk_id,
                content_hash: c.content_hash,
                file_path: c.file_path,
                start_line: c.start_line,
                end_line: c.end_line,
                node_type: c.node_type,
                name: c.name,
                language: c.language,
            })
            .collect();
        db::upsert_chunks_batch(&mut conn, &batch).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_chunks_to_branch_batch(&self, branch: String, chunk_ids: Vec<String>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::add_chunks_to_branch_batch(&mut conn, &branch, &chunk_ids)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn clear_branch(&self, branch: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count =
            db::clear_branch(&conn, &branch).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn get_branch_chunk_ids(&self, branch: String) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_branch_chunk_ids(&conn, &branch).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_branch_delta(&self, branch: String, base_branch: String) -> Result<BranchDelta> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let delta = db::get_branch_delta(&conn, &branch, &base_branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(BranchDelta {
            added: delta.added,
            removed: delta.removed,
        })
    }

    #[napi]
    pub fn chunk_exists_on_branch(&self, branch: String, chunk_id: String) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::chunk_exists_on_branch(&conn, &branch, &chunk_id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_all_branches(&self) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_all_branches(&conn).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_metadata(&self, key: String) -> Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_metadata(&conn, &key).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn set_metadata(&self, key: String, value: String) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::set_metadata(&conn, &key, &value).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn delete_metadata(&self, key: String) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::delete_metadata(&conn, &key).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn gc_orphan_embeddings(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count =
            db::gc_orphan_embeddings(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn gc_orphan_chunks(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::gc_orphan_chunks(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn get_stats(&self) -> Result<DatabaseStats> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let stats = db::get_stats(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(DatabaseStats {
            embedding_count: stats.embedding_count as u32,
            chunk_count: stats.chunk_count as u32,
            branch_chunk_count: stats.branch_chunk_count as u32,
            branch_count: stats.branch_count as u32,
            symbol_count: stats.symbol_count as u32,
            call_edge_count: stats.call_edge_count as u32,
        })
    }

    // ── Symbol methods ──────────────────────────────────────────────

    #[napi]
    pub fn upsert_symbol(&self, symbol: SymbolData) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let row = db::SymbolRow {
            id: symbol.id,
            file_path: symbol.file_path,
            name: symbol.name,
            kind: symbol.kind,
            start_line: symbol.start_line,
            start_col: symbol.start_col,
            end_line: symbol.end_line,
            end_col: symbol.end_col,
            language: symbol.language,
        };
        db::upsert_symbol(&conn, &row).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_symbols_batch(&self, symbols: Vec<SymbolData>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows: Vec<db::SymbolRow> = symbols
            .into_iter()
            .map(|s| db::SymbolRow {
                id: s.id,
                file_path: s.file_path,
                name: s.name,
                kind: s.kind,
                start_line: s.start_line,
                start_col: s.start_col,
                end_line: s.end_line,
                end_col: s.end_col,
                language: s.language,
            })
            .collect();
        db::upsert_symbols_batch(&mut conn, &rows).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_symbols_by_file(&self, file_path: String) -> Result<Vec<SymbolData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_symbols_by_file(&conn, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| SymbolData {
                id: r.id,
                file_path: r.file_path,
                name: r.name,
                kind: r.kind,
                start_line: r.start_line,
                start_col: r.start_col,
                end_line: r.end_line,
                end_col: r.end_col,
                language: r.language,
            })
            .collect())
    }

    #[napi]
    pub fn delete_symbols_by_file(&self, file_path: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::delete_symbols_by_file(&conn, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    // ── Call Edge methods ────────────────────────────────────────────

    #[napi]
    pub fn upsert_call_edge(&self, edge: CallEdgeData) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let row = db::CallEdgeRow {
            id: edge.id,
            from_symbol_id: edge.from_symbol_id,
            target_name: edge.target_name,
            to_symbol_id: edge.to_symbol_id,
            call_type: edge.call_type,
            line: edge.line,
            col: edge.col,
            is_resolved: edge.is_resolved,
        };
        db::upsert_call_edge(&conn, &row).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_call_edges_batch(&self, edges: Vec<CallEdgeData>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows: Vec<db::CallEdgeRow> = edges
            .into_iter()
            .map(|e| db::CallEdgeRow {
                id: e.id,
                from_symbol_id: e.from_symbol_id,
                target_name: e.target_name,
                to_symbol_id: e.to_symbol_id,
                call_type: e.call_type,
                line: e.line,
                col: e.col,
                is_resolved: e.is_resolved,
            })
            .collect();
        db::upsert_call_edges_batch(&mut conn, &rows)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_callers(&self, symbol_name: String, branch: String) -> Result<Vec<CallEdgeData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_callers(&conn, &symbol_name, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| CallEdgeData {
                id: r.id,
                from_symbol_id: r.from_symbol_id,
                target_name: r.target_name,
                to_symbol_id: r.to_symbol_id,
                call_type: r.call_type,
                line: r.line,
                col: r.col,
                is_resolved: r.is_resolved,
            })
            .collect())
    }

    #[napi]
    pub fn get_callees(&self, symbol_id: String) -> Result<Vec<CallEdgeData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_callees(&conn, &symbol_id)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| CallEdgeData {
                id: r.id,
                from_symbol_id: r.from_symbol_id,
                target_name: r.target_name,
                to_symbol_id: r.to_symbol_id,
                call_type: r.call_type,
                line: r.line,
                col: r.col,
                is_resolved: r.is_resolved,
            })
            .collect())
    }

    #[napi]
    pub fn delete_call_edges_by_file(&self, file_path: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::delete_call_edges_by_file(&conn, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn resolve_call_edge(&self, edge_id: String, to_symbol_id: String) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::resolve_call_edge(&conn, &edge_id, &to_symbol_id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    // ── Branch Symbol methods ────────────────────────────────────────

    #[napi]
    pub fn add_symbols_to_branch(&self, branch: String, symbol_ids: Vec<String>) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::add_symbols_to_branch(&conn, &branch, &symbol_ids)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_symbols_to_branch_batch(
        &self,
        branch: String,
        symbol_ids: Vec<String>,
    ) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::add_symbols_to_branch_batch(&mut conn, &branch, &symbol_ids)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_branch_symbol_ids(&self, branch: String) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_branch_symbol_ids(&conn, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn clear_branch_symbols(&self, branch: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::clear_branch_symbols(&conn, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    // ── GC methods for symbols/edges ─────────────────────────────────

    #[napi]
    pub fn gc_orphan_symbols(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count =
            db::gc_orphan_symbols(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn gc_orphan_call_edges(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count =
            db::gc_orphan_call_edges(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }
}
