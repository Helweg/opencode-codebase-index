; Direct function calls: foo(), mean(x), helper(a, b)
(function_call
  name: (identifier) @callee.name) @call

; Method/package calls where the whole dotted expression is called:
; obj.method(), pkg.func(), Foo.Bar.baz()
(function_call
  name: (field_expression
    field: (identifier) @callee.name)) @call @method.call

; Method/package calls where the dotted field owns the arguments:
; obj.method(x), pkg.func(x), Foo.Bar.baz(x)
(field_expression
  field: (function_call
    name: (identifier) @callee.name) @call) @method.call
