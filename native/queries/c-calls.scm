; Appels directs : foo(), bar(1, 2)
(call_expression
  function: (identifier) @callee.name) @call

; Includes locaux et système : #include "header.h", #include <stdio.h>
(preproc_include
  path: [
    (string_literal)
    (system_lib_string)
  ] @import.name) @import

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

; Alias de pointeurs ou de types fonction.
(type_definition
  declarator: (function_declarator
    declarator: (parenthesized_declarator
      (pointer_declarator
        declarator: (type_identifier) @indirect.type))))

(type_definition
  declarator: (function_declarator
    declarator: (type_identifier) @indirect.type))

; Paramètres déclarés avec un alias de fonction indirecte.
(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (identifier) @indirect.variable)

(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (pointer_declarator
    declarator: (identifier) @indirect.variable))

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
  declarator: (init_declarator
    declarator: (identifier) @indirect.variable))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (init_declarator
    declarator: (pointer_declarator
      declarator: (identifier) @indirect.variable)))
