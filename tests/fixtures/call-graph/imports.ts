// Import statements test fixture
// Tests various import patterns that represent cross-file call edges

// Named imports
import { parseFile, hashContent } from "../native";
import { Indexer } from "../indexer/index";
import { Logger } from "../utils/logger";

// Default import
import Database from "../database";

// Namespace import
import * as path from "path";
import * as fs from "fs";

// Type-only imports (should not create call edges)
import type { CodeChunk } from "../types";
import type { Config } from "../config";

// Mixed imports
import React, { useState, useEffect } from "react";

// Dynamic import (call expression)
async function loadModule() {
  const module = await import("../utils/helpers");
  return module.helperFunction();
}

// Re-export (not a call, but related)
export { parseFile, hashContent } from "../native";
export * from "../types";

// Using imported functions
function useImports() {
  const hash = hashContent("test");        // Call to imported function
  const chunks = parseFile("file.ts");     // Another imported call
  
  const indexer = new Indexer({});         // Constructor from import
  const logger = new Logger();
  
  logger.info("test");                     // Method on imported class instance
  
  const p = path.join("a", "b");           // Namespace import usage
  fs.readFileSync(p);                      // Another namespace call
}
