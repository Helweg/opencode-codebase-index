import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";

function getNativeBinding() {
  const platform = os.platform();
  const arch = os.arch();

  let bindingName: string;
  
  if (platform === "darwin" && arch === "arm64") {
    bindingName = "codebase-index-native.darwin-arm64.node";
  } else if (platform === "darwin" && arch === "x64") {
    bindingName = "codebase-index-native.darwin-x64.node";
  } else if (platform === "linux" && arch === "x64") {
    bindingName = "codebase-index-native.linux-x64-gnu.node";
  } else if (platform === "linux" && arch === "arm64") {
    bindingName = "codebase-index-native.linux-arm64-gnu.node";
  } else if (platform === "win32" && arch === "x64") {
    bindingName = "codebase-index-native.win32-x64-msvc.node";
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  // Get the directory of this module - works in both ESM and bundled contexts
  const currentFileUrl = typeof import.meta !== 'undefined' ? import.meta.url : __filename;
  const currentDir = typeof currentFileUrl === 'string' && currentFileUrl.startsWith('file:') 
    ? path.dirname(fileURLToPath(currentFileUrl))
    : __dirname;
  
  // The native module is in the 'native' folder at package root
  // From dist/index.js, we go up one level to package root, then into native/
  // From src/native/index.ts (dev/test), we go up two levels to package root
  const isDevMode = currentDir.includes('/src/native');
  const packageRoot = isDevMode 
    ? path.resolve(currentDir, '../..') 
    : path.resolve(currentDir, '..');
  const nativePath = path.join(packageRoot, 'native', bindingName);
  
  // Use createRequire to load .node files in ESM context
  const require = createRequire(currentFileUrl);
  return require(nativePath);
}

const native = getNativeBinding();

export interface FileInput {
  path: string;
  content: string;
}

export interface CodeChunk {
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  name?: string;
  language: string;
}

export type ChunkType =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "impl"
  | "trait"
  | "module"
  | "import"
  | "export"
  | "comment"
  | "other";

export interface ParsedFile {
  path: string;
  chunks: CodeChunk[];
  hash: string;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  filePath: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  name?: string;
  language: string;
  hash: string;
}

export function parseFile(filePath: string, content: string): CodeChunk[] {
  const result = native.parseFile(filePath, content);
  return result.map(mapChunk);
}

export function parseFiles(files: FileInput[]): ParsedFile[] {
  const result = native.parseFiles(files);
  return result.map((f: any) => ({
    path: f.path,
    chunks: f.chunks.map(mapChunk),
    hash: f.hash,
  }));
}

function mapChunk(c: any): CodeChunk {
  return {
    content: c.content,
    startLine: c.startLine ?? c.start_line,
    endLine: c.endLine ?? c.end_line,
    chunkType: (c.chunkType ?? c.chunk_type) as ChunkType,
    name: c.name ?? undefined,
    language: c.language,
  };
}

export function hashContent(content: string): string {
  return native.hashContent(content);
}

export function hashFile(filePath: string): string {
  return native.hashFile(filePath);
}

export class VectorStore {
  private inner: any;
  private dimensions: number;

  constructor(indexPath: string, dimensions: number) {
    this.inner = new native.VectorStore(indexPath, dimensions);
    this.dimensions = dimensions;
  }

  add(id: string, vector: number[], metadata: ChunkMetadata): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
      );
    }
    this.inner.add(id, vector, JSON.stringify(metadata));
  }

  addBatch(
    items: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }>
  ): void {
    const ids = items.map((i) => i.id);
    const vectors = items.map((i) => {
      if (i.vector.length !== this.dimensions) {
        throw new Error(
          `Vector dimension mismatch for ${i.id}: expected ${this.dimensions}, got ${i.vector.length}`
        );
      }
      return i.vector;
    });
    const metadata = items.map((i) => JSON.stringify(i.metadata));
    this.inner.addBatch(ids, vectors, metadata);
  }

  search(queryVector: number[], limit: number = 10): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${queryVector.length}`
      );
    }
    const results = this.inner.search(queryVector, limit);
    return results.map((r: any) => ({
      id: r.id,
      score: r.score,
      metadata: JSON.parse(r.metadata) as ChunkMetadata,
    }));
  }

  remove(id: string): boolean {
    return this.inner.remove(id);
  }

  save(): void {
    this.inner.save();
  }

  load(): void {
    this.inner.load();
  }

  count(): number {
    return this.inner.count();
  }

  clear(): void {
    this.inner.clear();
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getAllKeys(): string[] {
    return this.inner.getAllKeys();
  }

  getAllMetadata(): Array<{ key: string; metadata: ChunkMetadata }> {
    const results = this.inner.getAllMetadata();
    return results.map((r: { key: string; metadata: string }) => ({
      key: r.key,
      metadata: JSON.parse(r.metadata) as ChunkMetadata,
    }));
  }
}

// Token estimation: ~4 chars per token for code (conservative)
const CHARS_PER_TOKEN = 4;
const MAX_BATCH_TOKENS = 7500; // Leave buffer under 8192 API limit
const MAX_SINGLE_CHUNK_TOKENS = 2000; // Truncate individual chunks beyond this

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function createEmbeddingText(chunk: CodeChunk, filePath: string): string {
  const parts: string[] = [];
  
  const fileName = filePath.split("/").pop() || filePath;
  const dirPath = filePath.split("/").slice(-3, -1).join("/");
  
  const langDescriptors: Record<string, string> = {
    typescript: "TypeScript",
    javascript: "JavaScript", 
    python: "Python",
    rust: "Rust",
    go: "Go",
    java: "Java",
  };
  
  const typeDescriptors: Record<string, string> = {
    function_declaration: "function",
    function: "function",
    arrow_function: "arrow function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type alias",
    enum_declaration: "enum",
    export_statement: "export",
    lexical_declaration: "variable declaration",
    function_definition: "function",
    class_definition: "class",
    function_item: "function",
    impl_item: "implementation",
    struct_item: "struct",
    enum_item: "enum",
    trait_item: "trait",
  };

  const lang = langDescriptors[chunk.language] || chunk.language;
  const typeDesc = typeDescriptors[chunk.chunkType] || chunk.chunkType;
  
  if (chunk.name) {
    parts.push(`${lang} ${typeDesc} "${chunk.name}"`);
  } else {
    parts.push(`${lang} ${typeDesc}`);
  }
  
  if (dirPath) {
    parts.push(`in ${dirPath}/${fileName}`);
  } else {
    parts.push(`in ${fileName}`);
  }
  
  const semanticHints = extractSemanticHints(chunk.name || "", chunk.content);
  if (semanticHints.length > 0) {
    parts.push(`Purpose: ${semanticHints.join(", ")}`);
  }
  
  parts.push("");
  
  let content = chunk.content;
  const headerLength = parts.join("\n").length;
  const maxContentChars = (MAX_SINGLE_CHUNK_TOKENS * CHARS_PER_TOKEN) - headerLength;
  
  if (content.length > maxContentChars) {
    content = content.slice(0, maxContentChars) + "\n... [truncated]";
  }
  
  parts.push(content);

  return parts.join("\n");
}

export function createDynamicBatches(chunks: Array<{ text: string; [key: string]: any }>): Array<Array<{ text: string; [key: string]: any }>> {
  const batches: Array<Array<{ text: string; [key: string]: any }>> = [];
  let currentBatch: Array<{ text: string; [key: string]: any }> = [];
  let currentTokens = 0;
  
  for (const chunk of chunks) {
    const chunkTokens = estimateTokens(chunk.text);
    
    if (currentBatch.length > 0 && currentTokens + chunkTokens > MAX_BATCH_TOKENS) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    
    currentBatch.push(chunk);
    currentTokens += chunkTokens;
  }
  
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  return batches;
}

function extractSemanticHints(name: string, content: string): string[] {
  const hints: string[] = [];
  const combined = `${name} ${content}`.toLowerCase();
  
  const signature = extractFunctionSignature(content);
  if (signature) {
    hints.push(signature);
  }
  
  const patterns: Array<[RegExp, string]> = [
    [/auth|login|logout|signin|signout|credential/i, "authentication"],
    [/password|hash|bcrypt|argon/i, "password handling"],
    [/token|jwt|bearer|oauth/i, "token management"],
    [/user|account|profile|member/i, "user management"],
    [/permission|role|access|authorize/i, "authorization"],
    [/validate|verify|check|assert/i, "validation"],
    [/error|exception|throw|catch/i, "error handling"],
    [/log|debug|trace|info|warn/i, "logging"],
    [/cache|memoize|store/i, "caching"],
    [/fetch|request|response|api|http/i, "HTTP/API"],
    [/database|db|query|sql|mongo/i, "database"],
    [/file|read|write|stream|path/i, "file operations"],
    [/parse|serialize|json|xml/i, "data parsing"],
    [/encrypt|decrypt|crypto|secret|cipher|cryptographic/i, "encryption/cryptography"],
    [/test|spec|mock|stub|expect/i, "testing"],
    [/config|setting|option|env/i, "configuration"],
    [/route|endpoint|handler|controller|middleware/i, "routing/middleware"],
    [/render|component|view|template/i, "UI rendering"],
    [/state|redux|store|dispatch/i, "state management"],
    [/hook|effect|memo|callback/i, "React hooks"],
  ];
  
  for (const [pattern, hint] of patterns) {
    if (pattern.test(combined) && !hints.includes(hint)) {
      hints.push(hint);
    }
  }
  
  return hints.slice(0, 6);
}

function extractFunctionSignature(content: string): string | null {
  const tsJsPatterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/,
    /(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>{]+))?\s*=>/,
    /(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/,
  ];
  
  const pyPatterns = [
    /def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/,
    /async\s+def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/,
  ];
  
  const goPatterns = [
    /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]+)\)|([^{\n]+))?/,
  ];
  
  const rustPatterns = [
    /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?/,
  ];
  
  for (const pattern of [...tsJsPatterns, ...pyPatterns, ...goPatterns, ...rustPatterns]) {
    const match = content.match(pattern);
    if (match) {
      const funcName = match[1];
      const params = match[2]?.trim() || "";
      const returnType = (match[3] || match[4])?.trim();
      
      const paramNames = extractParamNames(params);
      
      let sig = `${funcName}(${paramNames.join(", ")})`;
      if (returnType && returnType.length < 50) {
        sig += ` -> ${returnType.replace(/\s+/g, " ").trim()}`;
      }
      
      if (sig.length < 100) {
        return sig;
      }
    }
  }
  
  return null;
}

function extractParamNames(params: string): string[] {
  if (!params.trim()) return [];
  
  const names: string[] = [];
  const parts = params.split(",");
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    const tsMatch = trimmed.match(/^(\w+)\s*[?:]?/);
    const pyMatch = trimmed.match(/^(\w+)\s*(?::|=)/);
    const goMatch = trimmed.match(/^(\w+)\s+\w/);
    const rustMatch = trimmed.match(/^(\w+)\s*:/);
    
    const match = tsMatch || pyMatch || goMatch || rustMatch;
    if (match && match[1] !== "self" && match[1] !== "this") {
      names.push(match[1]);
    }
  }
  
  return names.slice(0, 5);
}

export function generateChunkId(filePath: string, chunk: CodeChunk): string {
  const hash = hashContent(`${filePath}:${chunk.startLine}:${chunk.endLine}:${chunk.content}`);
  return `chunk_${hash.slice(0, 16)}`;
}

export function generateChunkHash(chunk: CodeChunk): string {
  return hashContent(chunk.content);
}
