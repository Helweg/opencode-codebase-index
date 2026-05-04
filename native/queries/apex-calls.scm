; =============================================================
; Tree-sitter query for extracting function/method calls from
; Salesforce Apex (tree-sitter-sfapex)
;
; Apex uses a single `method_invocation` node for both direct calls
; (foo(); helper(1, 2)) and method calls (obj.method(); this.foo();
; MyClass.staticDo()). The two cases are distinguished by the presence
; of an `object` field. We use the `.` anchor on the first pattern to
; match invocations where `name` is the first named child (i.e. no
; `object`), and a second pattern that explicitly requires an `object`
; field for method-style invocations.
; =============================================================

; -------------------------------------------------------------
; Direct function calls: foo(), helper(1, 2)
; The `.` anchor ensures `name` is the first named child, meaning
; the invocation has no object/receiver.
; -------------------------------------------------------------
(method_invocation
  .
  name: (identifier) @callee.name) @call

; -------------------------------------------------------------
; Method calls on a receiver: obj.method(), this.foo(),
; MyClass.staticDo(), Foo.Bar.deepCall()
;
; Apex makes no syntactic distinction between instance and static
; method calls — both produce `method_invocation` with an `object`
; field. We tag both as @method.call here; the call_extractor
; reports them as MethodCall regardless.
; -------------------------------------------------------------
(method_invocation
  object: (_)
  name: (identifier) @callee.name) @call @method.call

; -------------------------------------------------------------
; Constructor calls: new MyClass(args), new Account(Name = 'X')
; -------------------------------------------------------------
(object_creation_expression
  type: (type_identifier) @callee.name) @constructor
