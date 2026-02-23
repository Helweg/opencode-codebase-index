; =============================================================
; Tree-sitter query for extracting function calls from Python
; =============================================================

; Direct function calls: foo(), bar(1, 2)
(call
  function: (identifier) @callee.name) @call

; Method calls: obj.method(), self.foo()
(call
  function: (attribute
    attribute: (identifier) @callee.name)) @call

; Constructor calls (same as function calls in Python, but capitalized by convention)
; Handled by the Call type — caller can check capitalization

; Import: import foo
(import_statement
  name: (dotted_name
    (identifier) @import.name)) @import

; From import: from module import foo, bar
(import_from_statement
  name: (dotted_name
    (identifier) @import.name)) @import
