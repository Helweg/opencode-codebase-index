use crate::types::Language;
use crate::{CodeChunk, FileInput, ParsedFile};
use anyhow::{anyhow, Result};
use rayon::prelude::*;
use std::path::Path;
use tree_sitter::{Parser, Tree};

const MIN_CHUNK_SIZE: usize = 50;
const MAX_CHUNK_SIZE: usize = 2000;
const TARGET_CHUNK_SIZE: usize = 500;
const OVERLAP_LINES: usize = 3;

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
        Language::TypeScript | Language::TypeScriptTsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Language::JavaScript | Language::JavaScriptJsx => tree_sitter_javascript::LANGUAGE.into(),
        Language::Python => tree_sitter_python::LANGUAGE.into(),
        Language::Rust => tree_sitter_rust::LANGUAGE.into(),
        Language::Go => tree_sitter_go::LANGUAGE.into(),
        Language::Json => tree_sitter_json::LANGUAGE.into(),
        Language::Java => tree_sitter_java::LANGUAGE.into(),
        Language::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
        Language::Ruby => tree_sitter_ruby::LANGUAGE.into(),
        Language::Bash => tree_sitter_bash::LANGUAGE.into(),
        Language::C => tree_sitter_c::LANGUAGE.into(),
        Language::Cpp => tree_sitter_cpp::LANGUAGE.into(),
        _ => return Ok(chunk_by_lines(content, &language)),
    };

    parser.set_language(&ts_language)?;

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
            let mut start_byte = node.start_byte();
            let end_byte = node.end_byte();
            
            let leading_comment = find_leading_comment(&node, source, language);
            if let Some((comment_start, _comment_text)) = &leading_comment {
                start_byte = *comment_start;
            }
            
            let content = &source[start_byte..end_byte];

            if content.len() >= MIN_CHUNK_SIZE {
                let name = extract_name(cursor, source);

                let start_line = if leading_comment.is_some() {
                    source[..start_byte].matches('\n').count() as u32 + 1
                } else {
                    node.start_position().row as u32 + 1
                };

                let chunk = CodeChunk {
                    content: content.to_string(),
                    start_line,
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

fn find_leading_comment(node: &tree_sitter::Node, source: &str, language: &Language) -> Option<(usize, String)> {
    let mut prev = node.prev_sibling();
    let mut comments = Vec::new();
    
    while let Some(sibling) = prev {
        if is_comment_node(sibling.kind(), language) {
            let start = sibling.start_byte();
            let end = sibling.end_byte();
            let text = source[start..end].to_string();
            comments.push((start, text));
            prev = sibling.prev_sibling();
        } else {
            break;
        }
    }
    
    if comments.is_empty() {
        return None;
    }
    
    comments.reverse();
    let first_start = comments.first().map(|(s, _)| *s)?;
    let combined: String = comments.into_iter().map(|(_, t)| t).collect::<Vec<_>>().join("\n");
    
    Some((first_start, combined))
}

fn is_comment_node(node_type: &str, language: &Language) -> bool {
    match language {
        Language::TypeScript | Language::TypeScriptTsx | Language::JavaScript | Language::JavaScriptJsx => {
            matches!(node_type, "comment")
        }
        Language::Python => {
            matches!(node_type, "comment")
        }
        Language::Rust => {
            matches!(node_type, "line_comment" | "block_comment")
        }
        Language::Go => {
            matches!(node_type, "comment")
        }
        Language::Java => {
            matches!(node_type, "line_comment" | "block_comment")
        }
        Language::CSharp => {
            matches!(node_type, "comment")
        }
        Language::Ruby => {
            matches!(node_type, "comment")
        }
        Language::Bash => {
            matches!(node_type, "comment")
        }
        Language::C | Language::Cpp => {
            matches!(node_type, "comment")
        }
        _ => false,
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
                "class_declaration"
                    | "method_declaration"
                    | "constructor_declaration"
                    | "interface_declaration"
                    | "enum_declaration"
                    | "annotation_type_declaration"
            )
        }
        Language::CSharp => {
            matches!(
                node_type,
                "class_declaration"
                    | "method_declaration"
                    | "constructor_declaration"
                    | "interface_declaration"
                    | "enum_declaration"
                    | "struct_declaration"
                    | "record_declaration"
                    | "property_declaration"
            )
        }
        Language::Ruby => {
            matches!(
                node_type,
                "method" | "singleton_method" | "class" | "module"
            )
        }
        Language::Bash => {
            matches!(node_type, "function_definition")
        }
        Language::C => {
            matches!(
                node_type,
                "function_definition" | "struct_specifier" | "enum_specifier" | "type_definition"
            )
        }
        Language::Cpp => {
            matches!(
                node_type,
                "function_definition"
                    | "class_specifier"
                    | "struct_specifier"
                    | "enum_specifier"
                    | "namespace_definition"
                    | "template_declaration"
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
    let step_size = if lines_per_chunk > OVERLAP_LINES {
        lines_per_chunk - OVERLAP_LINES
    } else {
        lines_per_chunk
    };
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

        if end >= total_lines {
            break;
        }
        start += step_size;
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
    let step_size = if lines_per_chunk > OVERLAP_LINES {
        lines_per_chunk - OVERLAP_LINES
    } else {
        lines_per_chunk
    };
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

        if end >= total_lines {
            break;
        }
        start += step_size;
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

    #[test]
    fn test_chunk_overlap() {
        let lines: Vec<String> = (0..100).map(|i| format!("line {} content here", i)).collect();
        let content = lines.join("\n");
        
        let chunks = chunk_by_lines(&content, &Language::Unknown);
        
        assert!(chunks.len() >= 2, "Should have multiple chunks");
        
        if chunks.len() >= 2 {
            let first_end = chunks[0].end_line;
            let second_start = chunks[1].start_line;
            assert!(
                second_start <= first_end,
                "Chunks should overlap: first ends at {}, second starts at {}",
                first_end,
                second_start
            );
        }
    }

    #[test]
    fn test_jsdoc_extraction() {
        let content = r#"
/**
 * Validates a user's email address format.
 * @param email The email to validate
 * @returns true if valid, false otherwise
 */
function validateEmail(email: string): boolean {
    return email.includes('@') && email.includes('.');
}
"#;

        let chunks = parse_file_internal("test.ts", content).unwrap();
        assert!(!chunks.is_empty(), "Should have at least one chunk");
        
        let chunk = &chunks[0];
        assert!(
            chunk.content.contains("Validates a user's email"),
            "Chunk should include JSDoc comment: {}",
            chunk.content
        );
        assert!(
            chunk.content.contains("function validateEmail"),
            "Chunk should include function: {}",
            chunk.content
        );
    }

    #[test]
    fn test_rust_doc_comment_extraction() {
        let content = r#"
/// Calculates the factorial of a number.
/// Returns None if the input would cause overflow.
fn factorial(n: u64) -> Option<u64> {
    if n <= 1 { Some(1) } else { n.checked_mul(factorial(n - 1)?) }
}
"#;

        let chunks = parse_file_internal("test.rs", content).unwrap();
        assert!(!chunks.is_empty(), "Should have at least one chunk");
        
        let chunk = &chunks[0];
        assert!(
            chunk.content.contains("Calculates the factorial"),
            "Chunk should include doc comment: {}",
            chunk.content
        );
    }

    #[test]
    fn test_parse_java() {
        let content = r#"
public class Calculator {
    private int value;

    public Calculator() {
        this.value = 0;
    }

    public int add(int a, int b) {
        return a + b;
    }
}

public interface Computable {
    int compute(int input);
}

public enum Operation {
    ADD, SUBTRACT, MULTIPLY, DIVIDE
}
"#;

        let chunks = parse_file_internal("Calculator.java", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for Java");
        
        let has_class = chunks.iter().any(|c| c.chunk_type == "class_declaration");
        assert!(has_class, "Should find class_declaration");
    }

    #[test]
    fn test_parse_csharp() {
        let content = r#"
public class Person
{
    public string Name { get; set; }

    public Person(string name)
    {
        Name = name;
    }

    public void Greet()
    {
        Console.WriteLine($"Hello, {Name}!");
    }
}

public interface IGreeter
{
    void Greet();
}

public struct Point
{
    public int X;
    public int Y;
}
"#;

        let chunks = parse_file_internal("Person.cs", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for C#");
    }

    #[test]
    fn test_parse_ruby() {
        let content = r#"
class Greeter
  def initialize(name)
    @name = name
  end

  def greet
    puts "Hello, #{@name}!"
  end

  def self.default_greeting
    "Hello, World!"
  end
end

module Utils
  def self.format(str)
    str.strip.downcase
  end
end
"#;

        let chunks = parse_file_internal("greeter.rb", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for Ruby");
        
        let has_class = chunks.iter().any(|c| c.chunk_type == "class");
        assert!(has_class, "Should find class");
    }

    #[test]
    fn test_parse_bash() {
        let content = r#"
#!/bin/bash

function greet() {
    local name=$1
    echo "Hello, $name!"
}

function add() {
    local a=$1
    local b=$2
    echo $((a + b))
}

greet "World"
"#;

        let chunks = parse_file_internal("script.sh", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for Bash");
        
        let has_function = chunks.iter().any(|c| c.chunk_type == "function_definition");
        assert!(has_function, "Should find function_definition");
    }

    #[test]
    fn test_parse_c() {
        let content = r#"
#include <stdio.h>

struct Point {
    int x;
    int y;
};

enum Color {
    RED,
    GREEN,
    BLUE
};

int add(int a, int b) {
    return a + b;
}

void greet(const char* name) {
    printf("Hello, %s!\n", name);
}
"#;

        let chunks = parse_file_internal("main.c", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for C");
        
        let has_function = chunks.iter().any(|c| c.chunk_type == "function_definition");
        assert!(has_function, "Should find function_definition");
    }

    #[test]
    fn test_parse_cpp() {
        let content = r#"
#include <iostream>
#include <string>

namespace Math {
    int add(int a, int b) {
        return a + b;
    }
}

class Greeter {
private:
    std::string name;

public:
    Greeter(const std::string& n) : name(n) {}

    void greet() const {
        std::cout << "Hello, " << name << "!" << std::endl;
    }
};

struct Point {
    int x;
    int y;
};

template<typename T>
T max(T a, T b) {
    return (a > b) ? a : b;
}
"#;

        let chunks = parse_file_internal("main.cpp", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for C++");
        
        let has_class = chunks.iter().any(|c| c.chunk_type == "class_specifier");
        let has_namespace = chunks.iter().any(|c| c.chunk_type == "namespace_definition");
        assert!(has_class || has_namespace, "Should find class_specifier or namespace_definition");
    }
}
