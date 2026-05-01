; Direct function calls: foo(), bar(1, 2)
(call_expression
  function: (identifier) @callee.name) @call

; Method/field calls: obj.method()
(call_expression
  function: (field_expression
    member: (identifier) @callee.name)) @call

; Builtin calls: @import("std"), @This()
(builtin_function
  (builtin_identifier) @callee.name) @call
