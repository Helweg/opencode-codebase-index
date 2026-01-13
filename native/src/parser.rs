use crate::types::Language;
use crate::{CodeChunk, FileInput, ParsedFile};
use anyhow::{anyhow, Result};
use rayon::prelude::*;
use std::path::Path;
use tree_sitter::{Parser, Tree};

const MIN_CHUNK_SIZE: usize = 50;
const MAX_CHUNK_SIZE: usize = 2000;
const TARGET_CHUNK_SIZE: usize = 500;

pub fn parse_file_internal(file_path: &str, content: &str) -> Result<Vec<CodeChunk>> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let language = Language::from_extension(ext);

    if language == Language::Unknown {
        return Ok(chunk_by_lines(content, &language));
    }

    let mut parser = Parser::new();

    let ts_language = match language {
        Language::TypeScript | Language::TypeScriptTsx => tree_sitter_typescript::language_tsx(),
        Language::JavaScript | Language::JavaScriptJsx => tree_sitter_javascript::language(),
        Language::Python => tree_sitter_python::language(),
        Language::Rust => tree_sitter_rust::language(),
        Language::Go => tree_sitter_go::language(),
        Language::Java => tree_sitter_java::language(),
        Language::C => tree_sitter_c::language(),
        Language::Cpp => tree_sitter_cpp::language(),
        Language::Json => tree_sitter_json::language(),
        Language::Toml => tree_sitter_toml::language(),
        Language::Yaml => tree_sitter_yaml::language(),
        Language::Bash => tree_sitter_bash::language(),
        Language::Markdown => tree_sitter_markdown::language(),
        Language::Unknown => return Ok(chunk_by_lines(content, &language)),
    };

    parser.set_language(ts_language)?;

    let tree = parser
        .parse(content, None)
        .ok_or_else(|| anyhow!("Failed to parse file: {}", file_path))?;

    extract_chunks(&tree, content, &language)
}

pub fn parse_files_parallel(files: Vec<FileInput>) -> Result<Vec<ParsedFile>> {
    let results: Vec<ParsedFile> = files
        .par_iter()
        .filter_map(|file| {
            let chunks = parse_file_internal(&file.path, &file.content).ok()?;
            let hash = crate::hasher::xxhash_content(&file.content);
            Some(ParsedFile {
                path: file.path.clone(),
                chunks,
                hash,
            })
        })
        .collect();

    Ok(results)
}

fn extract_chunks(tree: &Tree, source: &str, language: &Language) -> Result<Vec<CodeChunk>> {
    let mut chunks = Vec::new();
    let root = tree.root_node();
    let mut cursor = root.walk();

    extract_semantic_nodes(&mut cursor, source, language, &mut chunks);

    if chunks.is_empty() {
        return Ok(chunk_by_lines(source, language));
    }

    merge_small_chunks(&mut chunks);

    Ok(chunks)
}

fn extract_semantic_nodes(
    cursor: &mut tree_sitter::TreeCursor,
    source: &str,
    language: &Language,
    chunks: &mut Vec<CodeChunk>,
) {
    loop {
        let node = cursor.node();
        let node_type = node.kind();

        let is_semantic = is_semantic_node(node_type, language);

        if is_semantic {
            let start_byte = node.start_byte();
            let end_byte = node.end_byte();
            let content = &source[start_byte..end_byte];

            if content.len() >= MIN_CHUNK_SIZE {
                let name = extract_name(cursor, source);

                let chunk = CodeChunk {
                    content: content.to_string(),
                    start_line: node.start_position().row as u32 + 1,
                    end_line: node.end_position().row as u32 + 1,
                    chunk_type: node_type.to_string(),
                    name,
                    language: language.as_str().to_string(),
                };

                if content.len() <= MAX_CHUNK_SIZE {
                    chunks.push(chunk);
                } else {
                    split_large_chunk(chunk, chunks);
                }
            }
        }

        if !is_semantic && cursor.goto_first_child() {
            extract_semantic_nodes(cursor, source, language, chunks);
            cursor.goto_parent();
        }

        if !cursor.goto_next_sibling() {
            break;
        }
    }
}

fn is_semantic_node(node_type: &str, language: &Language) -> bool {
    match language {
        Language::TypeScript | Language::TypeScriptTsx | Language::JavaScript | Language::JavaScriptJsx => {
            matches!(
                node_type,
                "function_declaration"
                    | "function"
                    | "arrow_function"
                    | "method_definition"
                    | "class_declaration"
                    | "interface_declaration"
                    | "type_alias_declaration"
                    | "enum_declaration"
                    | "export_statement"
                    | "lexical_declaration"
            )
        }
        Language::Python => {
            matches!(
                node_type,
                "function_definition" | "class_definition" | "decorated_definition"
            )
        }
        Language::Rust => {
            matches!(
                node_type,
                "function_item"
                    | "impl_item"
                    | "struct_item"
                    | "enum_item"
                    | "trait_item"
                    | "mod_item"
                    | "macro_definition"
            )
        }
        Language::Go => {
            matches!(
                node_type,
                "function_declaration"
                    | "method_declaration"
                    | "type_declaration"
                    | "type_spec"
            )
        }
        Language::Java => {
            matches!(
                node_type,
                "method_declaration"
                    | "class_declaration"
                    | "interface_declaration"
                    | "enum_declaration"
                    | "constructor_declaration"
            )
        }
        Language::C | Language::Cpp => {
            matches!(
                node_type,
                "function_definition"
                    | "struct_specifier"
                    | "class_specifier"
                    | "enum_specifier"
            )
        }
        _ => false,
    }
}

fn extract_name(cursor: &tree_sitter::TreeCursor, source: &str) -> Option<String> {
    let node = cursor.node();

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            let kind = child.kind();
            if kind == "identifier"
                || kind == "property_identifier"
                || kind == "type_identifier"
                || kind == "name"
            {
                let start = child.start_byte();
                let end = child.end_byte();
                return Some(source[start..end].to_string());
            }
        }
    }

    None
}

fn split_large_chunk(chunk: CodeChunk, chunks: &mut Vec<CodeChunk>) {
    let lines: Vec<&str> = chunk.content.lines().collect();
    let total_lines = lines.len();

    if total_lines <= 1 {
        chunks.push(chunk);
        return;
    }

    let lines_per_chunk = TARGET_CHUNK_SIZE / 40;
    let mut start = 0;

    while start < total_lines {
        let end = std::cmp::min(start + lines_per_chunk, total_lines);
        let sub_content: String = lines[start..end].join("\n");

        if sub_content.len() >= MIN_CHUNK_SIZE {
            chunks.push(CodeChunk {
                content: sub_content,
                start_line: chunk.start_line + start as u32,
                end_line: chunk.start_line + end as u32 - 1,
                chunk_type: chunk.chunk_type.clone(),
                name: chunk.name.clone(),
                language: chunk.language.clone(),
            });
        }

        start = end;
    }
}

fn merge_small_chunks(chunks: &mut Vec<CodeChunk>) {
    if chunks.len() < 2 {
        return;
    }

    let mut merged = Vec::with_capacity(chunks.len());
    let mut current: Option<CodeChunk> = None;

    for chunk in chunks.drain(..) {
        match current.take() {
            None => {
                current = Some(chunk);
            }
            Some(mut cur) => {
                if cur.content.len() < MIN_CHUNK_SIZE * 2
                    && cur.content.len() + chunk.content.len() <= MAX_CHUNK_SIZE
                    && cur.end_line + 1 >= chunk.start_line
                {
                    cur.content.push_str("\n\n");
                    cur.content.push_str(&chunk.content);
                    cur.end_line = chunk.end_line;
                    current = Some(cur);
                } else {
                    merged.push(cur);
                    current = Some(chunk);
                }
            }
        }
    }

    if let Some(cur) = current {
        merged.push(cur);
    }

    *chunks = merged;
}

fn chunk_by_lines(content: &str, language: &Language) -> Vec<CodeChunk> {
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();

    if total_lines == 0 {
        return Vec::new();
    }

    let lines_per_chunk = 30;
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < total_lines {
        let end = std::cmp::min(start + lines_per_chunk, total_lines);
        let sub_content: String = lines[start..end].join("\n");

        if sub_content.len() >= MIN_CHUNK_SIZE {
            chunks.push(CodeChunk {
                content: sub_content,
                start_line: start as u32 + 1,
                end_line: end as u32,
                chunk_type: "block".to_string(),
                name: None,
                language: language.as_str().to_string(),
            });
        }

        start = end;
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_typescript() {
        let content = r#"
function greet(name: string): string {
    return `Hello, ${name}!`;
}

class Greeter {
    private name: string;
    
    constructor(name: string) {
        this.name = name;
    }
    
    greet(): string {
        return `Hello, ${this.name}!`;
    }
}
"#;

        let chunks = parse_file_internal("test.ts", content).unwrap();
        assert!(!chunks.is_empty());
    }

    #[test]
    fn test_parse_python() {
        let content = r#"
def greet(name: str) -> str:
    return f"Hello, {name}!"

class Greeter:
    def __init__(self, name: str):
        self.name = name
    
    def greet(self) -> str:
        return f"Hello, {self.name}!"
"#;

        let chunks = parse_file_internal("test.py", content).unwrap();
        assert!(!chunks.is_empty());
    }
}
