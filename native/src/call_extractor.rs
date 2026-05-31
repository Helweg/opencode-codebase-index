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
        Language::Php => tree_sitter_php::LANGUAGE_PHP.into(),
        Language::Zig => tree_sitter_zig::LANGUAGE.into(),
        Language::Matlab => tree_sitter_matlab::LANGUAGE.into(),
        Language::Apex => tree_sitter_sfapex::apex::LANGUAGE.into(),
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
        Language::TypeScript | Language::TypeScriptTsx => {
            include_str!("../queries/typescript-calls.scm")
        }
        Language::JavaScript | Language::JavaScriptJsx => {
            include_str!("../queries/javascript-calls.scm")
        }
        Language::Python => include_str!("../queries/python-calls.scm"),
        Language::Rust => include_str!("../queries/rust-calls.scm"),
        Language::Go => include_str!("../queries/go-calls.scm"),
        Language::Php => include_str!("../queries/php-calls.scm"),
        Language::Zig => include_str!("../queries/zig-calls.scm"),
        Language::Matlab => include_str!("../queries/matlab-calls.scm"),
        Language::Apex => include_str!("../queries/apex-calls.scm"),
        _ => return Ok(vec![]),
    };

    let query = Query::new(&ts_language, query_source)
        .map_err(|e| anyhow!("Failed to compile query: {}", e))?;

    let callee_name_idx = query.capture_index_for_name("callee.name");
    let call_idx = query.capture_index_for_name("call");
    let method_call_idx = query.capture_index_for_name("method.call");
    let static_call_idx = query.capture_index_for_name("static.call");
    let constructor_idx = query.capture_index_for_name("constructor");
    let import_name_idx = query.capture_index_for_name("import.name");
    let import_default_idx = query.capture_index_for_name("import.default");
    let import_namespace_idx = query.capture_index_for_name("import.namespace");

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
                if capture.index == idx {
                    // Check if this is actually a method call by looking at other captures
                    // If method_call_idx or static_call_idx also matches, it's a method call
                    let is_method_call = match_.captures.iter().any(|c| {
                        method_call_idx.map(|idx| c.index == idx).unwrap_or(false)
                            || static_call_idx.map(|idx| c.index == idx).unwrap_or(false)
                    });

                    if is_method_call {
                        call_type = Some(CallType::MethodCall);
                    } else {
                        call_type = Some(CallType::Call);
                    }
                }
            }

            if let Some(idx) = method_call_idx {
                if capture.index == idx && call_type.is_none() {
                    call_type = Some(CallType::MethodCall);
                }
            }

            if let Some(idx) = static_call_idx {
                if capture.index == idx && call_type.is_none() {
                    call_type = Some(CallType::MethodCall);
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

        // PHP method calls are already marked in query (@method.call, @static.call)
        // @call is only for direct function calls
        // So we need to check if the call was already classified as a method call
        if let (Some(name), Some(ct), Some(pos)) = (callee_name, call_type, position) {
            // PHP and Apex are case-insensitive at the language level; normalize
            // callee names to lowercase so that HELPER() matches symbol `helper`
            // during resolution and lookup. Constructor names keep their original
            // casing because they need to match class declarations (which are
            // resolved by exact name in this codebase). Import names are PHP-only
            // and similarly preserve their casing.
            let normalized_name = if (language == Language::Php || language == Language::Apex)
                && ct != CallType::Import
                && ct != CallType::Constructor
            {
                name.to_lowercase()
            } else {
                name.clone()
            };

            calls.push(CallSite {
                callee_name: normalized_name,
                line: pos.0,
                column: pos.1,
                call_type: ct,
            });
        }
    }

    let mut deduped: Vec<CallSite> = Vec::new();
    for call in calls {
        if let Some(existing) = deduped.iter_mut().find(|existing| {
            existing.callee_name == call.callee_name
                && existing.line == call.line
                && existing.column == call.column
        }) {
            if call_type_specificity(call.call_type) > call_type_specificity(existing.call_type) {
                *existing = call;
            }
        } else {
            deduped.push(call);
        }
    }

    Ok(deduped)
}

fn call_type_specificity(call_type: CallType) -> u8 {
    match call_type {
        CallType::Call => 0,
        CallType::MethodCall => 1,
        CallType::Constructor => 2,
        CallType::Import => 2,
    }
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
            "Expected method call (self.foo()), got: {:?}",
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
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::Call),
            "Expected foo call, got: {:?}",
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
            "Expected method call (self.foo()), got: {:?}",
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

    #[test]
    fn test_php_direct_calls() {
        let code = "<?php\nfunction caller() { directCall(); helper(1, 2); }";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "directcall" && c.call_type == CallType::Call),
            "Expected directcall (lowercased), got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "helper" && c.call_type == CallType::Call),
            "Expected helper call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_case_insensitive_calls() {
        let code = "<?php\nfunction caller() { HELPER(); MyFunc(); }";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "helper" && c.call_type == CallType::Call),
            "Expected HELPER() normalized to helper, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "myfunc" && c.call_type == CallType::Call),
            "Expected MyFunc() normalized to myfunc, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_method_calls() {
        let code = "<?php\n$obj->method();\n$obj?->safe();";
        let calls = extract_calls(code, "php").unwrap();
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
                .any(|c| c.callee_name == "safe" && c.call_type == CallType::MethodCall),
            "Expected nullsafe method call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_case_insensitive_method_calls() {
        let code = "<?php\n$obj->Method();\nFoo::Bar();";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "method" && c.call_type == CallType::MethodCall),
            "Expected Method() normalized to method, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "bar" && c.call_type == CallType::MethodCall),
            "Expected Bar() normalized to bar, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_static_calls() {
        let code = "<?php\nFoo::bar();\nself::create();";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "bar" && c.call_type == CallType::MethodCall),
            "Expected static method call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "create" && c.call_type == CallType::MethodCall),
            "Expected static method call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_grouped_imports() {
        let code = "<?php\nuse App\\Helpers\\{StringHelper, ArrayHelper};";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "StringHelper" && c.call_type == CallType::Import),
            "Expected StringHelper import, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "ArrayHelper" && c.call_type == CallType::Import),
            "Expected ArrayHelper import, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_constructors() {
        let code = "<?php\n$obj = new SimpleClass();\n$obj2 = new ClassWithArgs(1, 2);";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "SimpleClass" && c.call_type == CallType::Constructor),
            "Expected SimpleClass constructor, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "ClassWithArgs" && c.call_type == CallType::Constructor),
            "Expected ClassWithArgs constructor, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_imports() {
        let code = "<?php\nuse App\\Models\\User;\nuse App\\Services\\AuthService;";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "User" && c.call_type == CallType::Import),
            "Expected User import, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "AuthService" && c.call_type == CallType::Import),
            "Expected AuthService import, got: {:?}",
            calls
        );
    }
}
