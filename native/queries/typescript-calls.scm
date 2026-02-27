; =============================================================
; Tree-sitter query file for extracting function calls from TS/JS
; Captures are named with @ prefix and used to extract node text
; =============================================================

; -------------------------------------------------------------
; Direct function calls: foo(), bar(1, 2)
; Captures the function identifier being called
; -------------------------------------------------------------
(call_expression
  function: (identifier) @callee.name) @call

; -------------------------------------------------------------
; Method calls: obj.method(), this.foo(), array.map()
; Captures the property (method name) being called
; -------------------------------------------------------------
(call_expression
  function: (member_expression
    property: (property_identifier) @callee.name)) @call

; -------------------------------------------------------------
; Constructor calls: new Foo(), new Bar(args)
; Captures the class/constructor name
; -------------------------------------------------------------
(new_expression
  constructor: (identifier) @callee.name) @constructor

; -------------------------------------------------------------
; ES6 named imports: import { foo, bar as baz } from 'module'
; Captures each imported name and the source module
; -------------------------------------------------------------
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.name)))
  source: (string) @import.source) @import

; -------------------------------------------------------------
; Default imports: import React from 'react'
; Captures the default import name and source
; -------------------------------------------------------------
(import_statement
  (import_clause
    (identifier) @import.default)
  source: (string) @import.source) @import

; -------------------------------------------------------------
; Namespace imports: import * as utils from './utils'
; Captures the namespace alias and source
; -------------------------------------------------------------
(import_statement
  (import_clause
    (namespace_import
      (identifier) @import.namespace))
  source: (string) @import.source) @import
