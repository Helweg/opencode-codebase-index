; =============================================================
; Tree-sitter query for extracting function calls from GDScript
; Grammar: PrestonKnopp/tree-sitter-gdscript
; =============================================================
;
; GDScript has three call-shaped nodes:
;   - call            -> top-level call:        foo(), MyClass.new(), preload("x")
;   - attribute_call  -> trailing attribute:    obj.method()  (nested in `attribute`)
;   - base_call       -> super-call:            .ready()
;
; We do NOT try to extract calls hidden behind strings (call("foo"),
; emit_signal("name"), connect(..., "method")) because those depend on
; runtime resolution. They show up as same-line callees with no AST link.

; Direct function call: foo(), bar(1, 2)
(call
  (identifier) @callee.name) @call

; Method/member call: obj.method(), self.foo()
; `attribute_call` only appears nested inside an `attribute` node, so this
; pattern fires exactly once per member-call site.
(attribute_call
  (identifier) @callee.name) @call @method.call

; Super / base call: .ready(), .process(delta)
(base_call
  (identifier) @callee.name) @call @method.call
