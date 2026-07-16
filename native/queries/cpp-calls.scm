; Appels directs : foo(), bar(1, 2)
(call_expression
  function: (identifier) @callee.name) @call

; Appels de membres : object.method(), pointer->method()
; Les opérateurs de pointeur vers membre sont volontairement exclus.
(call_expression
  function: (field_expression
    operator: ["." "->"]
    field: (field_identifier) @callee.name)) @method.call

; Appels qualifiés : namespace::function(), Type::method()
; Sans analyse de types, ils restent classés comme appels directs.
(call_expression
  function: (qualified_identifier) @callee.name
  (#match? @callee.name "(^|::)[A-Za-z_][A-Za-z0-9_]*$")
  (#not-match? @callee.name "[<>]")) @call

; Constructeurs explicites : new Widget(...)
(new_expression
  type: (type_identifier) @callee.name) @constructor

; Constructeurs qualifiés : new namespace::Widget(...)
(new_expression
  type: (qualified_identifier) @callee.name
  (#match? @callee.name "(^|::)[A-Za-z_][A-Za-z0-9_]*$")
  (#not-match? @callee.name "[<>]")) @constructor

; Temporaires construits avec des accolades : Widget{...}
(compound_literal_expression
  type: (type_identifier) @callee.name) @constructor

; Temporaires qualifiés : namespace::Widget{...}
(compound_literal_expression
  type: (qualified_identifier) @callee.name
  (#match? @callee.name "(^|::)[A-Za-z_][A-Za-z0-9_]*$")
  (#not-match? @callee.name "[<>]")) @constructor

; Includes locaux et système : #include "header.hpp", #include <memory>
(preproc_include
  path: [
    (string_literal)
    (system_lib_string)
  ] @import.name) @import

; Imports de namespaces : using namespace std;
(using_declaration
  "namespace"
  (identifier) @import.namespace) @import

; Imports de namespaces qualifiés : using namespace project::detail;
(using_declaration
  "namespace"
  (qualified_identifier) @import.namespace
  (#not-match? @import.namespace "[<>]")) @import

; Macros définies dans le fichier, exclues des appels ordinaires.
(preproc_function_def
  name: (identifier) @excluded.name)

(preproc_def
  name: (identifier) @excluded.name)

; Variables, paramètres et alias de pointeurs de fonction.
(function_declarator
  declarator: (parenthesized_declarator
    (pointer_declarator
      declarator: [
        (identifier)
        (field_identifier)
        (type_identifier)
      ] @excluded.name)))

; Alias de pointeurs ou de types fonction, via typedef ou using.
(type_definition
  declarator: (function_declarator
    declarator: (parenthesized_declarator
      (pointer_declarator
        declarator: (type_identifier) @indirect.type))))

(type_definition
  declarator: (function_declarator
    declarator: (type_identifier) @indirect.type))

(alias_declaration
  name: (type_identifier) @indirect.type
  type: (type_descriptor
    declarator: (abstract_function_declarator)))

; Paramètres déclarés avec un alias de fonction indirecte.
(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (identifier) @indirect.variable)

(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (pointer_declarator
    declarator: (identifier) @indirect.variable))

(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (reference_declarator
    (identifier) @indirect.variable))

; Champs appelables déclarés avec un alias de fonction indirecte.
(field_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (field_identifier) @indirect.variable)

(field_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (pointer_declarator
    declarator: (field_identifier) @indirect.variable))

; Variables locales ou globales déclarées avec le même type d'alias.
(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (identifier) @indirect.variable)

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (pointer_declarator
    declarator: (identifier) @indirect.variable))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (reference_declarator
    (identifier) @indirect.variable))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (init_declarator
    declarator: (identifier) @indirect.variable))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (init_declarator
    declarator: (pointer_declarator
      declarator: (identifier) @indirect.variable)))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (init_declarator
    declarator: (reference_declarator
      (identifier) @indirect.variable)))
