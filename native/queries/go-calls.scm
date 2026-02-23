; =============================================================
; Tree-sitter query for extracting function calls from Go
; =============================================================

; Direct function calls: foo(), bar(1, 2)
(call_expression
  function: (identifier) @callee.name) @call

; Method/package calls: obj.Method(), fmt.Println()
(call_expression
  function: (selector_expression
    field: (field_identifier) @callee.name)) @call

; Import: import "fmt"
(import_spec
  path: (interpreted_string_literal) @import.name) @import
