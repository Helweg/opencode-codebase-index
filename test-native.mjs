import { parseFile, hashContent, VectorStore } from "./dist/index.mjs";

const testCode = `
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

class Greeter {
  private name: string;
  
  constructor(name: string) {
    this.name = name;
  }
  
  greet(): string {
    return \`Hello, \${this.name}!\`;
  }
}

export { greet, Greeter };
`;

console.log("Testing native bindings...\n");

console.log("1. Testing parseFile:");
try {
  const chunks = parseFile("test.ts", testCode);
  console.log(`   Parsed ${chunks.length} chunks:`);
  chunks.forEach((c, i) => {
    console.log(`   [${i + 1}] ${c.chunkType}${c.name ? ` "${c.name}"` : ""} (lines ${c.startLine}-${c.endLine})`);
  });
} catch (e) {
  console.log(`   Error: ${e.message}`);
}

console.log("\n2. Testing hashContent:");
try {
  const hash = hashContent("Hello, World!");
  console.log(`   Hash: ${hash}`);
} catch (e) {
  console.log(`   Error: ${e.message}`);
}

console.log("\n3. Testing VectorStore:");
try {
  const store = new VectorStore("/tmp/test-vector-store", 4);
  console.log(`   Created store with ${store.getDimensions()} dimensions`);
  
  store.add("test-1", [0.1, 0.2, 0.3, 0.4], {
    filePath: "test.ts",
    startLine: 1,
    endLine: 10,
    chunkType: "function",
    name: "greet",
    language: "typescript",
    hash: "abc123"
  });
  
  console.log(`   Added vector, count: ${store.count()}`);
  
  const results = store.search([0.1, 0.2, 0.3, 0.4], 5);
  console.log(`   Search returned ${results.length} results`);
  if (results.length > 0) {
    console.log(`   Top result: ${results[0].metadata.name} (score: ${results[0].score.toFixed(3)})`);
  }
  
  store.clear();
  console.log(`   Cleared, count: ${store.count()}`);
} catch (e) {
  console.log(`   Error: ${e.message}`);
}

console.log("\nAll tests completed!");
