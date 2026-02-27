; =============================================================
; Tree-sitter query for extracting function calls from Rust
; =============================================================

; Direct function calls: foo(), bar(1, 2)
(call_expression
  function: (identifier) @callee.name) @call

; Method calls: obj.method(), self.foo()
(call_expression
  function: (field_expression
    field: (field_identifier) @callee.name)) @call

; Path calls: std::fs::read(), Vec::new()
(call_expression
  function: (scoped_identifier
    name: (identifier) @callee.name)) @call

; Macro calls: println!(), vec![]
(macro_invocation
  macro: (identifier) @callee.name) @call

; Use imports: use std::fs;
(use_declaration
  argument: (scoped_identifier
    name: (identifier) @import.name)) @import

; Use list imports: use std::{foo, bar};
(use_declaration
  argument: (scoped_use_list
    list: (use_list
      (identifier) @import.name))) @import
