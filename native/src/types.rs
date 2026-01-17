use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkMetadata {
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub chunk_type: String,
    pub name: Option<String>,
    pub language: String,
    pub file_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    TypeScript,
    TypeScriptTsx,
    JavaScript,
    JavaScriptJsx,
    Python,
    Rust,
    Go,
    Java,
    CSharp,
    Ruby,
    C,
    Cpp,
    Json,
    Toml,
    Yaml,
    Bash,
    Markdown,
    Unknown,
}

impl Language {
    pub fn from_extension(ext: &str) -> Self {
        match ext.to_lowercase().as_str() {
            "ts" | "mts" | "cts" => Language::TypeScript,
            "tsx" => Language::TypeScriptTsx,
            "js" | "mjs" | "cjs" => Language::JavaScript,
            "jsx" => Language::JavaScriptJsx,
            "py" | "pyi" => Language::Python,
            "rs" => Language::Rust,
            "go" => Language::Go,
            "java" => Language::Java,
            "cs" => Language::CSharp,
            "rb" => Language::Ruby,
            "c" | "h" => Language::C,
            "cpp" | "cc" | "cxx" | "hpp" | "hxx" => Language::Cpp,
            "json" => Language::Json,
            "toml" => Language::Toml,
            "yaml" | "yml" => Language::Yaml,
            "sh" | "bash" | "zsh" => Language::Bash,
            "md" | "mdx" => Language::Markdown,
            _ => Language::Unknown,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Language::TypeScript => "typescript",
            Language::TypeScriptTsx => "tsx",
            Language::JavaScript => "javascript",
            Language::JavaScriptJsx => "jsx",
            Language::Python => "python",
            Language::Rust => "rust",
            Language::Go => "go",
            Language::Java => "java",
            Language::CSharp => "csharp",
            Language::Ruby => "ruby",
            Language::C => "c",
            Language::Cpp => "cpp",
            Language::Json => "json",
            Language::Toml => "toml",
            Language::Yaml => "yaml",
            Language::Bash => "bash",
            Language::Markdown => "markdown",
            Language::Unknown => "unknown",
        }
    }
}
