; =============================================================
; Tree-sitter query for extracting function calls from GDScript
; Grammar: PrestonKnopp/tree-sitter-gdscript
; =============================================================
;
; GDScript has three call-shaped nodes:
;   - call            -> direct call:    foo(), preload("x")
;   - attribute_call  -> member call:    obj.method()  (nested in `attribute`)
;   - base_call       -> super-call:     .ready()
;
; A member call `recv.method()` parses as
;   (attribute (identifier)... (attribute_call (identifier) ...))
; so the receiver is the identifier immediately before `attribute_call`.
;
; Two member-call idioms must resolve to the RECEIVER, not the method name,
; because that is the symbol the call graph indexes:
;   - signal.emit()  -> the signal declaration  (signal_statement)
;   - Class.new()    -> the class declaration    (class_name / class_definition)
; Capturing `emit` / `new` here would dangle, since neither is an indexed
; symbol, and would leave the signal/class looking unreferenced.
;
; We do NOT extract string-dispatched calls (call("foo"),
; emit_signal("name"), connect(..., "method")): those need runtime
; resolution and have no AST link.

; Direct function call: foo(), bar(1, 2)
(call
  (identifier) @callee.name) @call

; Signal emission (Godot 4): my_signal.emit(...) -> target = signal name.
; The anchored identifier is the one directly before `.emit`, so this also
; resolves chained receivers like `self.my_signal.emit()`.
(attribute
  (identifier) @callee.name
  .
  (attribute_call
    (identifier) @_method (#eq? @_method "emit"))) @call @method.call

; Instantiation: MyClass.new(...) -> target = class name (a constructor call).
(attribute
  (identifier) @callee.name
  .
  (attribute_call
    (identifier) @_method (#eq? @_method "new"))) @constructor

; Generic member call: obj.method(), self.foo()
; emit/new are handled above and excluded here so the signal/class target is
; not shadowed by the method name.
(attribute_call
  (identifier) @callee.name
  (#not-eq? @callee.name "emit")
  (#not-eq? @callee.name "new")) @call @method.call

; Super / base call: .ready(), .process(delta)
(base_call
  (identifier) @callee.name) @call @method.call
