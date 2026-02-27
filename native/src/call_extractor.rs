use crate::types::Language;
use anyhow::{anyhow, Result};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Parser, Query, QueryCursor};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallType {
    Call,
    MethodCall,
    Constructor,
    Import,
}

#[derive(Debug, Clone)]
pub struct CallSite {
    pub callee_name: String,
    pub line: u32,
    pub column: u32,
    pub call_type: CallType,
}

pub fn extract_calls(content: &str, language_name: &str) -> Result<Vec<CallSite>> {
    let language = Language::from_string(language_name);
    let ts_language = match language {
        Language::TypeScript | Language::TypeScriptTsx => {
            tree_sitter_typescript::LANGUAGE_TSX.into()
        }
        Language::JavaScript | Language::JavaScriptJsx => tree_sitter_javascript::LANGUAGE.into(),
        Language::Python => tree_sitter_python::LANGUAGE.into(),
        Language::Rust => tree_sitter_rust::LANGUAGE.into(),
        Language::Go => tree_sitter_go::LANGUAGE.into(),
        _ => return Ok(vec![]),
    };

    let mut parser = Parser::new();
    parser
        .set_language(&ts_language)
        .map_err(|e| anyhow!("Failed to set language: {}", e))?;

    let tree = parser
        .parse(content, None)
        .ok_or_else(|| anyhow!("Parse failed"))?;

    let query_source = match language {
        Language::TypeScript
        | Language::TypeScriptTsx
        | Language::JavaScript
        | Language::JavaScriptJsx => include_str!("../queries/typescript-calls.scm"),
        Language::Python => include_str!("../queries/python-calls.scm"),
        Language::Rust => include_str!("../queries/rust-calls.scm"),
        Language::Go => include_str!("../queries/go-calls.scm"),
        _ => return Ok(vec![]),
    };

    let query = Query::new(&ts_language, query_source)
        .map_err(|e| anyhow!("Failed to compile query: {}", e))?;

    let callee_name_idx = query.capture_index_for_name("callee.name");
    let call_idx = query.capture_index_for_name("call");
    let constructor_idx = query.capture_index_for_name("constructor");
    let import_name_idx = query.capture_index_for_name("import.name");
    let import_default_idx = query.capture_index_for_name("import.default");
    let import_namespace_idx = query.capture_index_for_name("import.namespace");

    let method_parent_kinds: &[&str] = match language {
        Language::TypeScript
        | Language::TypeScriptTsx
        | Language::JavaScript
        | Language::JavaScriptJsx => &["member_expression"],
        Language::Python => &["attribute"],
        Language::Rust => &["field_expression"],
        Language::Go => &["selector_expression"],
        _ => &[],
    };

    let mut cursor = QueryCursor::new();
    let mut calls = Vec::new();
    let text_bytes = content.as_bytes();

    let mut captures_iter = cursor.captures(&query, tree.root_node(), text_bytes);

    while let Some((match_, _)) = captures_iter.next() {
        let mut callee_name: Option<String> = None;
        let mut call_type: Option<CallType> = None;
        let mut position: Option<(u32, u32)> = None;

        for capture in match_.captures {
            let node = capture.node;
            let text = node.utf8_text(text_bytes).unwrap_or("");

            if let Some(idx) = callee_name_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    if position.is_none() {
                        let start = node.start_position();
                        position = Some((start.row as u32 + 1, start.column as u32));
                    }
                }
            }

            if let Some(idx) = call_idx {
                if capture.index == idx && call_type.is_none() {
                    call_type = Some(CallType::Call);
                }
            }

            if let Some(idx) = constructor_idx {
                if capture.index == idx {
                    call_type = Some(CallType::Constructor);
                }
            }

            if let Some(idx) = import_name_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    call_type = Some(CallType::Import);
                    let start = node.start_position();
                    position = Some((start.row as u32 + 1, start.column as u32));
                }
            }

            if let Some(idx) = import_default_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    call_type = Some(CallType::Import);
                    let start = node.start_position();
                    position = Some((start.row as u32 + 1, start.column as u32));
                }
            }

            if let Some(idx) = import_namespace_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    call_type = Some(CallType::Import);
                    let start = node.start_position();
                    position = Some((start.row as u32 + 1, start.column as u32));
                }
            }
        }

        if let (Some(name), Some(CallType::Call), Some(pos)) = (&callee_name, call_type, position) {
            let is_method_call = match_.captures.iter().any(|c| {
                if let Some(idx) = callee_name_idx {
                    if c.index == idx {
                        if let Some(parent) = c.node.parent() {
                            return method_parent_kinds.contains(&parent.kind());
                        }
                    }
                }
                false
            });

            let final_call_type = if is_method_call {
                CallType::MethodCall
            } else {
                CallType::Call
            };

            calls.push(CallSite {
                callee_name: name.clone(),
                line: pos.0,
                column: pos.1,
                call_type: final_call_type,
            });
        } else if let (Some(name), Some(ct), Some(pos)) = (callee_name, call_type, position) {
            calls.push(CallSite {
                callee_name: name,
                line: pos.0,
                column: pos.1,
                call_type: ct,
            });
        }
    }

    Ok(calls)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_direct_calls() {
        let code = "function test() { foo(); bar(1, 2); }";
        let calls = extract_calls(code, "typescript").unwrap();
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "foo" && c.call_type == CallType::Call));
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "bar" && c.call_type == CallType::Call));
    }

    #[test]
    fn test_extract_method_calls() {
        let code = "obj.method(); this.foo();";
        let calls = extract_calls(code, "typescript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "method" && c.call_type == CallType::MethodCall),
            "Expected method call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::MethodCall),
            "Expected method call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_extract_constructors() {
        let code = "new Foo(); new Bar(1, 2);";
        let calls = extract_calls(code, "typescript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "Foo" && c.call_type == CallType::Constructor),
            "Expected constructor call, got: {:?}",
            calls
        );
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "Bar" && c.call_type == CallType::Constructor));
    }

    #[test]
    fn test_extract_imports() {
        let code = r#"
            import { foo, bar } from 'module1';
            import React from 'react';
            import * as utils from './utils';
        "#;
        let calls = extract_calls(code, "typescript").unwrap();

        assert!(calls
            .iter()
            .any(|c| c.callee_name == "foo" && c.call_type == CallType::Import));
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "bar" && c.call_type == CallType::Import));
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "React" && c.call_type == CallType::Import));
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "utils" && c.call_type == CallType::Import));
    }

    #[test]
    fn test_line_column_numbers() {
        let code = "foo();\nbar();";
        let calls = extract_calls(code, "typescript").unwrap();

        let foo_call = calls.iter().find(|c| c.callee_name == "foo").unwrap();
        assert_eq!(foo_call.line, 1);
        assert_eq!(foo_call.column, 0);

        let bar_call = calls.iter().find(|c| c.callee_name == "bar").unwrap();
        assert_eq!(bar_call.line, 2);
        assert_eq!(bar_call.column, 0);
    }

    #[test]
    fn test_javascript_support() {
        let code = "console.log('test'); alert('hi');";
        let calls = extract_calls(code, "javascript").unwrap();
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "log" && c.call_type == CallType::MethodCall));
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "alert" && c.call_type == CallType::Call));
    }

    #[test]
    fn test_python_direct_calls() {
        let code = "print('hello')\nlen([1, 2, 3])";
        let calls = extract_calls(code, "python").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "print" && c.call_type == CallType::Call),
            "Expected print call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "len" && c.call_type == CallType::Call),
            "Expected len call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_python_method_calls() {
        let code = "obj.method()\nself.foo()";
        let calls = extract_calls(code, "python").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "method" && c.call_type == CallType::MethodCall),
            "Expected method call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::MethodCall),
            "Expected method call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_python_imports() {
        let code = "import os\nfrom pathlib import Path";
        let calls = extract_calls(code, "python").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "os" && c.call_type == CallType::Import),
            "Expected os import, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "Path" && c.call_type == CallType::Import),
            "Expected Path import, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_go_direct_calls() {
        let code = "package main\nfunc main() { foo() }";
        let calls = extract_calls(code, "go").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::Call),
            "Expected foo call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_go_method_calls() {
        let code = "package main\nfunc main() { fmt.Println(\"hello\") }";
        let calls = extract_calls(code, "go").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "Println" && c.call_type == CallType::MethodCall),
            "Expected Println method call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_rust_direct_calls() {
        let code = "fn main() { foo(); bar(1, 2); }";
        let calls = extract_calls(code, "rust").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::Call),
            "Expected foo call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "bar" && c.call_type == CallType::Call),
            "Expected bar call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_rust_method_calls() {
        let code = "fn main() { self.foo(); obj.method(); }";
        let calls = extract_calls(code, "rust").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::MethodCall),
            "Expected foo method call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "method" && c.call_type == CallType::MethodCall),
            "Expected method call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_unsupported_language() {
        let code = "<html><body>hello</body></html>";
        let calls = extract_calls(code, "html").unwrap();
        assert_eq!(calls.len(), 0);
    }
}
