use crate::SearchResult;
use anyhow::{anyhow, Result};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use usearch::{new_index, Index, IndexOptions, MetricKind, ScalarKind};

#[derive(Serialize, Deserialize, Default)]
struct StoredMetadata {
    id_to_key: HashMap<u64, String>,
    key_to_id: HashMap<String, u64>,
    metadata: HashMap<String, String>,
    next_id: u64,
}

pub struct VectorStoreInner {
    index: Index,
    index_path: PathBuf,
    metadata_path: PathBuf,
    stored: StoredMetadata,
    dimensions: usize,
}

impl VectorStoreInner {
    pub fn new(index_path: PathBuf, dimensions: usize) -> Result<Self> {
        let options = IndexOptions {
            dimensions,
            metric: MetricKind::Cos,
            quantization: ScalarKind::F16,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        };

        let index = new_index(&options)?;

        let metadata_path = index_path.with_extension("meta.json");

        let mut store = Self {
            index,
            index_path,
            metadata_path,
            stored: StoredMetadata::default(),
            dimensions,
        };

        if store.index_path.exists() {
            let _ = store.load();
        }

        Ok(store)
    }

    pub fn add(&mut self, key: &str, vector: &[f32], metadata: &str) -> Result<()> {
        if vector.len() != self.dimensions {
            return Err(anyhow!(
                "Vector dimension mismatch: expected {}, got {}",
                self.dimensions,
                vector.len()
            ));
        }

        if let Some(&existing_id) = self.stored.key_to_id.get(key) {
            self.index.remove(existing_id)?;
            self.stored.id_to_key.remove(&existing_id);
        }

        let id = self.stored.next_id;
        self.stored.next_id += 1;

        if self.index.capacity() <= self.index.size() {
            let new_capacity = std::cmp::max(self.index.capacity() * 2, 1024);
            self.index.reserve(new_capacity)?;
        }

        self.index.add(id, vector)?;

        self.stored.id_to_key.insert(id, key.to_string());
        self.stored.key_to_id.insert(key.to_string(), id);
        self.stored.metadata.insert(key.to_string(), metadata.to_string());

        Ok(())
    }

    pub fn add_batch(
        &mut self,
        keys: &[String],
        vectors: &[Vec<f32>],
        metadata: &[String],
    ) -> Result<()> {
        if keys.len() != vectors.len() || keys.len() != metadata.len() {
            return Err(anyhow!("Mismatched batch sizes"));
        }

        let batch_size = keys.len();
        if batch_size == 0 {
            return Ok(());
        }

        for (i, vector) in vectors.iter().enumerate() {
            if vector.len() != self.dimensions {
                return Err(anyhow!(
                    "Vector {} dimension mismatch: expected {}, got {}",
                    i,
                    self.dimensions,
                    vector.len()
                ));
            }
        }

        let existing_ids: Vec<u64> = keys
            .iter()
            .filter_map(|key| self.stored.key_to_id.get(key).copied())
            .collect();

        for id in existing_ids {
            self.index.remove(id)?;
            if let Some(key) = self.stored.id_to_key.remove(&id) {
                self.stored.key_to_id.remove(&key);
            }
        }

        let current_size = self.index.size();
        let needed_capacity = current_size + batch_size;
        let num_threads = rayon::current_num_threads();
        self.index
            .reserve_capacity_and_threads(needed_capacity, num_threads)?;

        let start_id = self.stored.next_id;
        let failure_count = AtomicUsize::new(0);

        let ids: Vec<u64> = (0..batch_size).map(|i| start_id + i as u64).collect();

        ids.par_iter().zip(vectors.par_iter()).for_each(|(&id, vector)| {
            if self.index.add(id, vector).is_err() {
                failure_count.fetch_add(1, Ordering::Relaxed);
            }
        });

        if failure_count.load(Ordering::Relaxed) > 0 {
            return Err(anyhow!(
                "Failed to add {} vectors to index",
                failure_count.load(Ordering::Relaxed)
            ));
        }

        for (i, key) in keys.iter().enumerate() {
            let id = start_id + i as u64;
            self.stored.id_to_key.insert(id, key.clone());
            self.stored.key_to_id.insert(key.clone(), id);
            self.stored
                .metadata
                .insert(key.clone(), metadata[i].clone());
        }
        self.stored.next_id = start_id + batch_size as u64;

        Ok(())
    }

    pub fn search(&self, query_vector: &[f32], limit: usize) -> Result<Vec<SearchResult>> {
        if query_vector.len() != self.dimensions {
            return Err(anyhow!(
                "Query vector dimension mismatch: expected {}, got {}",
                self.dimensions,
                query_vector.len()
            ));
        }

        let results = self.index.search(query_vector, limit)?;

        let mut search_results = Vec::with_capacity(results.keys.len());

        for (i, &id) in results.keys.iter().enumerate() {
            if let Some(key) = self.stored.id_to_key.get(&id) {
                let metadata = self
                    .stored
                    .metadata
                    .get(key)
                    .cloned()
                    .unwrap_or_default();

                let score = 1.0 - results.distances[i] as f64;

                search_results.push(SearchResult {
                    id: key.clone(),
                    score,
                    metadata,
                });
            }
        }

        Ok(search_results)
    }

    pub fn remove(&mut self, key: &str) -> Result<bool> {
        if let Some(&id) = self.stored.key_to_id.get(key) {
            self.index.remove(id)?;
            self.stored.id_to_key.remove(&id);
            self.stored.key_to_id.remove(key);
            self.stored.metadata.remove(key);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn save(&self) -> Result<()> {
        if let Some(parent) = self.index_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let index_path_str = self
            .index_path
            .to_str()
            .ok_or_else(|| anyhow!("Index path contains invalid UTF-8: {:?}", self.index_path))?;
        self.index.save(index_path_str)?;

        let metadata_json = serde_json::to_string(&self.stored)?;
        fs::write(&self.metadata_path, metadata_json)?;

        Ok(())
    }

    pub fn load(&mut self) -> Result<()> {
        if self.index_path.exists() {
            let index_path_str = self
                .index_path
                .to_str()
                .ok_or_else(|| anyhow!("Index path contains invalid UTF-8: {:?}", self.index_path))?;
            self.index.load(index_path_str)?;
        }

        if self.metadata_path.exists() {
            let metadata_json = fs::read_to_string(&self.metadata_path)?;
            self.stored = serde_json::from_str(&metadata_json)?;
        }

        Ok(())
    }

    pub fn count(&self) -> usize {
        self.stored.key_to_id.len()
    }

    pub fn clear(&mut self) -> Result<()> {
        let options = IndexOptions {
            dimensions: self.dimensions,
            metric: MetricKind::Cos,
            quantization: ScalarKind::F16,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        };

        self.index = new_index(&options)?;
        self.stored = StoredMetadata::default();

        if self.index_path.exists() {
            fs::remove_file(&self.index_path)?;
        }
        if self.metadata_path.exists() {
            fs::remove_file(&self.metadata_path)?;
        }

        Ok(())
    }

    pub fn get_all_keys(&self) -> Vec<String> {
        self.stored.key_to_id.keys().cloned().collect()
    }

    pub fn get_all_metadata(&self) -> Vec<(String, String)> {
        self.stored
            .metadata
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_vector_store_basic() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        let mut store = VectorStoreInner::new(index_path, 3).unwrap();

        store.add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#).unwrap();
        store.add("vec2", &[0.0, 1.0, 0.0], r#"{"file": "b.ts"}"#).unwrap();
        store.add("vec3", &[0.0, 0.0, 1.0], r#"{"file": "c.ts"}"#).unwrap();

        assert_eq!(store.count(), 3);

        let results = store.search(&[1.0, 0.0, 0.0], 2).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].id, "vec1");
    }

    #[test]
    fn test_vector_store_persistence() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        {
            let mut store = VectorStoreInner::new(index_path.clone(), 3).unwrap();
            store.add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#).unwrap();
            store.save().unwrap();
        }

        {
            let mut store = VectorStoreInner::new(index_path, 3).unwrap();
            store.load().unwrap();
            assert_eq!(store.count(), 1);
        }
    }
}
