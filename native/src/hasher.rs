use xxhash_rust::xxh3::xxh3_64;
use std::fs;
use std::path::Path;
use anyhow::Result;

pub fn xxhash_content(content: &str) -> String {
    format!("{:016x}", xxh3_64(content.as_bytes()))
}

pub fn xxhash_file(file_path: &str) -> Result<String> {
    let content = fs::read(Path::new(file_path))?;
    Ok(format!("{:016x}", xxh3_64(&content)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_content() {
        let hash1 = xxhash_content("hello world");
        let hash2 = xxhash_content("hello world");
        let hash3 = xxhash_content("different content");
        
        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
        assert_eq!(hash1.len(), 16);
    }
}
