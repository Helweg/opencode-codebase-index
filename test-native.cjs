const path = require("path");
const os = require("os");

function getNativeBinding() {
  const platform = os.platform();
  const arch = os.arch();

  let bindingPath;
  
  if (platform === "darwin" && arch === "arm64") {
    bindingPath = "codebase-index-native.darwin-arm64.node";
  } else if (platform === "darwin" && arch === "x64") {
    bindingPath = "codebase-index-native.darwin-x64.node";
  } else if (platform === "linux" && arch === "x64") {
    bindingPath = "codebase-index-native.linux-x64-gnu.node";
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  return require(path.join(__dirname, "native", bindingPath));
}

const native = getNativeBinding();

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
  const chunks = native.parseFile("test.ts", testCode);
  console.log(`   Parsed ${chunks.length} chunks:`);
  chunks.forEach((c, i) => {
    console.log(`   [${i + 1}] ${c.chunk_type}${c.name ? ` "${c.name}"` : ""} (lines ${c.start_line}-${c.end_line})`);
  });
} catch (e) {
  console.log(`   Error: ${e.message}`);
}

console.log("\n2. Testing hashContent:");
try {
  const hash = native.hashContent("Hello, World!");
  console.log(`   Hash: ${hash}`);
} catch (e) {
  console.log(`   Error: ${e.message}`);
}

console.log("\n3. Testing VectorStore:");
try {
  const store = new native.VectorStore("/tmp/test-vector-store", 4);
  console.log(`   Created store with 4 dimensions`);
  
  store.add("test-1", [0.1, 0.2, 0.3, 0.4], JSON.stringify({
    filePath: "test.ts",
    startLine: 1,
    endLine: 10,
    chunkType: "function",
    name: "greet",
    language: "typescript",
    hash: "abc123"
  }));
  
  console.log(`   Added vector, count: ${store.count()}`);
  
  const results = store.search([0.1, 0.2, 0.3, 0.4], 5);
  console.log(`   Search returned ${results.length} results`);
  if (results.length > 0) {
    const meta = JSON.parse(results[0].metadata);
    console.log(`   Top result: ${meta.name} (score: ${results[0].score.toFixed(3)})`);
  }
  
  store.clear();
  console.log(`   Cleared, count: ${store.count()}`);
} catch (e) {
  console.log(`   Error: ${e.message}`);
}

console.log("\nAll tests completed!");
