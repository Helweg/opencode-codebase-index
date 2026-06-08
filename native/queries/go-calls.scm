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

; Struct embedding (Go inheritance pattern): type Foo struct { Bar }
; Only matches anonymous fields (no name: child) — not regular typed fields
(struct_type
  (field_declaration_list
    (field_declaration
      !name
      type: (type_identifier) @inherits.name))) @inherits

; Package-qualified struct embedding: type Foo struct { pkg.Base }
; Captures the type name from qualified anonymous embeds
(struct_type
  (field_declaration_list
    (field_declaration
      !name
      type: (qualified_type
        name: (type_identifier) @inherits.name)))) @inherits
; Only matches anonymous fields (no name: child) — not regular typed fields
(struct_type
  (field_declaration_list
    (field_declaration
      !name
      type: (type_identifier) @inherits.name))) @inherits
