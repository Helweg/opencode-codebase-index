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
  // @ts-ignore - import.meta.url is available in ESM
  const currentFileUrl = typeof import.meta !== 'undefined' ? import.meta.url : __filename;
  const currentDir = typeof currentFileUrl === 'string' && currentFileUrl.startsWith('file:') 
    ? path.dirname(fileURLToPath(currentFileUrl))
    : __dirname;
  
  // The native module is in the 'native' folder at package root
  // From dist/index.js, we go up one level to package root, then into native/
  const packageRoot = path.resolve(currentDir, '..');
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
    startLine: c.start_line,
    endLine: c.end_line,
    chunkType: c.chunk_type as ChunkType,
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
    parts.push(`${lang} ${typeDesc} named "${chunk.name}"`);
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
  parts.push(chunk.content);

  return parts.join("\n");
}

function extractSemanticHints(name: string, content: string): string[] {
  const hints: string[] = [];
  const combined = `${name} ${content}`.toLowerCase();
  
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
    [/encrypt|decrypt|crypto|secret/i, "encryption"],
    [/test|spec|mock|stub|expect/i, "testing"],
    [/config|setting|option|env/i, "configuration"],
    [/route|endpoint|handler|controller/i, "routing"],
    [/render|component|view|template/i, "UI rendering"],
    [/state|redux|store|dispatch/i, "state management"],
    [/hook|effect|memo|callback/i, "React hooks"],
  ];
  
  for (const [pattern, hint] of patterns) {
    if (pattern.test(combined) && !hints.includes(hint)) {
      hints.push(hint);
    }
  }
  
  return hints.slice(0, 5);
}

export function generateChunkId(filePath: string, chunk: CodeChunk): string {
  const hash = hashContent(`${filePath}:${chunk.startLine}:${chunk.endLine}:${chunk.content}`);
  return `chunk_${hash.slice(0, 16)}`;
}
