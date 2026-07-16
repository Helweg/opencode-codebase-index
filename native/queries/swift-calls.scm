; =============================================================
; Extraction du graphe d'appels Swift avec tree-sitter-swift 0.7.3
; =============================================================

; Appels directs, y compris sous try/await et avec trailing closure.
((call_expression
  .
  (simple_identifier) @callee.name
  (call_suffix) @call.suffix) @call
  (#match? @call.suffix "^[({]"))

; Type() est syntaxiquement identique à function().
((call_expression
  .
  (simple_identifier) @callee.name
  (call_suffix) @call.suffix) @constructor
  (#match? @call.suffix "^[({]")
  (#match? @callee.name "^[A-Z]"))

; Appels instance, static/class, self/super, optionnels et chaînés.
((call_expression
  .
  (navigation_expression
    suffix: (navigation_suffix
      suffix: (simple_identifier) @callee.name))
  (call_suffix) @call.suffix) @method.call
  (#match? @call.suffix "^[({]"))

; Module.Type() est syntaxiquement identique à object.method().
((call_expression
  .
  (navigation_expression
    suffix: (navigation_suffix
      suffix: (simple_identifier) @callee.name))
  (call_suffix) @call.suffix) @constructor
  (#match? @call.suffix "^[({]")
  (#match? @callee.name "^[A-Z]"))

; Type.init(), Module.Type.init(), self.init() et super.init().
((call_expression
  .
  (navigation_expression
    suffix: (navigation_suffix
      suffix: (simple_identifier) @callee.name))
  (call_suffix) @call.suffix) @constructor
  (#match? @call.suffix "^[({]")
  (#eq? @callee.name "init"))

; Membres implicites comme .success(value) et .init().
((call_expression
  .
  (prefix_expression
    (simple_identifier) @callee.name)
  (call_suffix) @call.suffix) @method.call
  (#match? @call.suffix "^[({]"))

((call_expression
  .
  (prefix_expression
    (simple_identifier) @callee.name)
  (call_suffix) @call.suffix) @constructor
  (#match? @call.suffix "^[({]")
  (#eq? @callee.name "init"))

; Invocation générique non qualifiée : generic<T>() ou Type<T>().
(constructor_expression
  constructed_type: (user_type
    .
    (type_identifier) @callee.name
    .
    (type_arguments))) @call

; Invocation générique qualifiée : object.method<T>() ou Module.Type<T>().
(constructor_expression
  constructed_type: (user_type
    (type_identifier)
    (type_identifier) @callee.name
    .
    (type_arguments))) @method.call

; Les invocations génériques en majuscule sont candidates constructeur.
((constructor_expression
  constructed_type: (user_type
    (type_identifier) @callee.name
    .
    (type_arguments))) @constructor
  (#match? @callee.name "^[A-Z]"))

; Initializer explicite générique.
((constructor_expression
  constructed_type: (user_type
    (type_identifier) @callee.name
    .
    (type_arguments))) @constructor
  (#eq? @callee.name "init"))

; Imports simples et sélectifs : conserver le nom terminal.
(import_declaration
  (identifier
    (simple_identifier) @import.name
    .)) @import

; Premier élément d'héritage d'une classe non générique.
(class_declaration
  declaration_kind: "class"
  name: (_)
  .
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @inherits.name .)
      (user_type (type_identifier) @inherits.name . (type_arguments))
    ])) @inherits

; Premier élément d'héritage d'une classe générique.
(class_declaration
  declaration_kind: "class"
  name: (_)
  (type_parameters)
  .
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @inherits.name .)
      (user_type (type_identifier) @inherits.name . (type_arguments))
    ])) @inherits

; Tout élément ayant un inheritance_specifier antérieur est une conformité.
; L'absence volontaire d'ancre entre les deux éléments est importante.
(class_declaration
  declaration_kind: "class"
  (inheritance_specifier)
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @implements.name .)
      (user_type (type_identifier) @implements.name . (type_arguments))
    ])) @implements

; Conformité annotée placée en premier : @unchecked, @preconcurrency, etc.
(class_declaration
  declaration_kind: "class"
  (attribute)
  .
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @implements.name .)
      (user_type (type_identifier) @implements.name . (type_arguments))
    ])) @implements

; Conformités des structs, enums, actors et extensions.
(class_declaration
  declaration_kind: [
    "actor"
    "enum"
    "extension"
    "struct"
  ]
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @implements.name .)
      (user_type (type_identifier) @implements.name . (type_arguments))
    ])) @implements

; Héritage de protocoles.
(protocol_declaration
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @inherits.name .)
      (user_type (type_identifier) @inherits.name . (type_arguments))
    ])) @inherits
