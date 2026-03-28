; =============================================================
; Tree-sitter query for extracting function calls from PHP
; =============================================================

; Direct function calls: foo(), strlen($s)
(function_call_expression
  function: (name) @callee.name) @call

; Qualified function calls: Namespace\foo()
(function_call_expression
  function: (qualified_name
    (name) @callee.name)) @call

; Method calls: $obj->method()
(member_call_expression
  name: (name) @callee.name) @call

; Nullsafe method calls: $obj?->method()
(nullsafe_member_call_expression
  name: (name) @callee.name) @call

; Static method calls: Foo::bar(), self::method()
(scoped_call_expression
  name: (name) @callee.name) @call

; Constructor calls: new Foo()
(object_creation_expression
  (name) @callee.name) @constructor

; Qualified constructor: new Namespace\Foo()
(object_creation_expression
  (qualified_name
    (name) @callee.name)) @constructor

; Use imports: use App\Models\User;
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name
      (name) @import.name))) @import

; Grouped use imports: use App\Models\{User, Post};
(namespace_use_declaration
  (namespace_use_group
    (namespace_use_clause
      (name) @import.name))) @import
