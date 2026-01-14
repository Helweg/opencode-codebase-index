#!/usr/bin/env node

import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BenchmarkQuery {
  query: string;
  description: string;
  expectedFiles: string[];
  expectedFunctions?: string[];
  ripgrepTerms?: string[];
}

interface SearchResult {
  query: string;
  method: "semantic" | "ripgrep";
  timeMs: number;
  foundFiles: string[];
  foundExpected: number;
  totalExpected: number;
  precision: number;
  recall: number;
}

interface TokenUsage {
  queryTokens: number;
  baselineTokens: number;
  savedTokens: number;
  savingsPercent: number;
}

function printUsage(): void {
  console.log(`
Usage: npx tsx scripts/benchmark.ts [options] <project-path>

Options:
  --queries <file>    JSON file with custom queries (see format below)
  --auto              Auto-generate queries based on codebase analysis
  --help              Show this help message

Query file format (JSON):
[
  {
    "query": "natural language search query",
    "expectedFiles": ["src/file1.ts", "src/file2.ts"]
  }
]

Examples:
  npx tsx scripts/benchmark.ts /path/to/project
  npx tsx scripts/benchmark.ts --queries queries.json /path/to/project
  npx tsx scripts/benchmark.ts --auto /path/to/express
`);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function calculateTokenUsage(projectRoot: string, queries: string[]): TokenUsage {
  let totalFileContent = "";
  
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"];
  
  function scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        scanDir(fullPath);
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        try {
          totalFileContent += fs.readFileSync(fullPath, "utf-8");
        } catch {}
      }
    }
  }
  
  scanDir(projectRoot);
  
  const baselineTokens = estimateTokens(totalFileContent) * queries.length;
  const queryTokens = queries.reduce((sum, q) => sum + estimateTokens(q), 0);
  const savedTokens = baselineTokens - queryTokens;
  const savingsPercent = baselineTokens > 0 ? (savedTokens / baselineTokens) * 100 : 0;
  
  return { queryTokens, baselineTokens, savedTokens, savingsPercent };
}

function loadQueriesFromFile(filePath: string): BenchmarkQuery[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content);
  return parsed.map((q: any) => ({
    query: q.query,
    description: q.description || q.query,
    expectedFiles: q.expectedFiles || [],
    expectedFunctions: q.expectedFunctions,
    ripgrepTerms: q.ripgrepTerms,
  }));
}

function autoGenerateQueries(projectRoot: string): BenchmarkQuery[] {
  const queries: BenchmarkQuery[] = [];
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"];
  const fileContents: Map<string, string> = new Map();
  
  function scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "build") {
        scanDir(fullPath);
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          fileContents.set(path.relative(projectRoot, fullPath), content);
        } catch {}
      }
    }
  }
  
  scanDir(projectRoot);
  
  const patterns: Array<{ regex: RegExp; queryTemplate: string }> = [
    { regex: /auth|login|logout|signin/i, queryTemplate: "authentication and login handling" },
    { regex: /password|hash|bcrypt/i, queryTemplate: "password hashing and security" },
    { regex: /token|jwt|bearer/i, queryTemplate: "token generation and validation" },
    { regex: /database|db|query|sql/i, queryTemplate: "database operations and queries" },
    { regex: /route|router|endpoint/i, queryTemplate: "routing and endpoint definitions" },
    { regex: /middleware/i, queryTemplate: "middleware functions" },
    { regex: /error|exception|catch/i, queryTemplate: "error handling and exceptions" },
    { regex: /cache|memoize/i, queryTemplate: "caching mechanisms" },
    { regex: /validate|validation|schema/i, queryTemplate: "input validation" },
    { regex: /render|component|view/i, queryTemplate: "rendering and view components" },
    { regex: /fetch|request|http|api/i, queryTemplate: "HTTP requests and API calls" },
    { regex: /config|settings|env/i, queryTemplate: "configuration management" },
    { regex: /test|spec|mock/i, queryTemplate: "testing utilities" },
    { regex: /log|logger|debug/i, queryTemplate: "logging and debugging" },
    { regex: /parse|serialize|json/i, queryTemplate: "data parsing and serialization" },
  ];
  
  const usedPatterns = new Set<string>();
  
  for (const [filePath, content] of fileContents) {
    for (const { regex, queryTemplate } of patterns) {
      if (regex.test(content) && !usedPatterns.has(queryTemplate)) {
        usedPatterns.add(queryTemplate);
        queries.push({
          query: queryTemplate,
          description: `Auto-detected: ${queryTemplate}`,
          expectedFiles: [filePath],
        });
        if (queries.length >= 10) break;
      }
    }
    if (queries.length >= 10) break;
  }
  
  if (queries.length === 0) {
    const sampleFiles = Array.from(fileContents.keys()).slice(0, 5);
    for (const file of sampleFiles) {
      const name = path.basename(file, path.extname(file));
      queries.push({
        query: `functionality in ${name}`,
        description: `Generic query for ${file}`,
        expectedFiles: [file],
      });
    }
  }
  
  return queries;
}

const DEFAULT_QUERIES: BenchmarkQuery[] = [
  {
    query: "password hashing and verification",
    description: "Find password security functions",
    expectedFiles: ["src/auth.ts"],
    expectedFunctions: ["hashPassword", "verifyPassword"],
  },
  {
    query: "JWT token generation",
    description: "Find JWT creation code",
    expectedFiles: ["src/auth.ts"],
    expectedFunctions: ["generateToken"],
  },
  {
    query: "authentication middleware",
    description: "Find auth middleware for routes",
    expectedFiles: ["src/auth.ts"],
    expectedFunctions: ["requireAuth"],
  },
  {
    query: "database transaction handling",
    description: "Find transaction management code",
    expectedFiles: ["src/database.ts"],
    expectedFunctions: ["transaction"],
  },
  {
    query: "user credentials validation",
    description: "Find credential checking logic",
    expectedFiles: ["src/auth.ts"],
    expectedFunctions: ["verifyPassword", "verifyToken"],
  },
  {
    query: "SQL query execution",
    description: "Find database query functions",
    expectedFiles: ["src/database.ts"],
    expectedFunctions: ["query"],
  },
  {
    query: "bearer token extraction from headers",
    description: "Find header parsing for auth",
    expectedFiles: ["src/auth.ts"],
    expectedFunctions: ["requireAuth"],
  },
  {
    query: "cryptographic operations",
    description: "Find crypto/hashing code",
    expectedFiles: ["src/auth.ts"],
    expectedFunctions: ["hashPassword"],
  },
  {
    query: "connection pool management",
    description: "Find DB connection handling",
    expectedFiles: ["src/database.ts"],
    expectedFunctions: ["closePool"],
  },
  {
    query: "error response handling for unauthorized requests",
    description: "Find 401 error responses",
    expectedFiles: ["src/auth.ts"],
    expectedFunctions: ["requireAuth"],
  },
];

function runRipgrep(projectRoot: string, query: string, ripgrepTerms?: string[]): { files: string[]; timeMs: number } {
  const keywords = ripgrepTerms || query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const start = performance.now();
  
  const foundFiles = new Set<string>();
  
  for (const keyword of keywords) {
    try {
      const result = execSync(
        `rg -l "${keyword}" "${projectRoot}" --type ts --type js --type tsx 2>/dev/null || rg -l "${keyword}" "${projectRoot}" -g "*.ts" -g "*.tsx" -g "*.js" -g "*.jsx" 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 5000 }
      );
      for (const file of result.trim().split("\n").filter(Boolean)) {
        foundFiles.add(path.relative(projectRoot, file));
      }
    } catch {
      // ignore errors
    }
  }
  
  const timeMs = performance.now() - start;
  return { files: Array.from(foundFiles), timeMs };
}

async function runSemanticSearch(
  projectRoot: string,
  query: string
): Promise<{ files: string[]; timeMs: number }> {
  const start = performance.now();
  
  try {
    const distPath = path.resolve(__dirname, "..", "dist", "index.cjs");
    const escapedQuery = query.replace(/'/g, "'\\''");
    const escapedProject = projectRoot.replace(/'/g, "'\\''");
    
    const script = `
const { Indexer, parseConfig } = require('${distPath}');
(async () => {
  const indexer = new Indexer('${escapedProject}', parseConfig({}));
  await indexer.initialize();
  const status = await indexer.getStatus();
  if (!status.indexed) {
    await indexer.index();
  }
  const results = await indexer.search('${escapedQuery}', 10);
  console.log(JSON.stringify(results.map(r => r.filePath)));
})().catch(e => {
  console.error(e.message);
  console.log('[]');
});
`;
    
    const result = execSync(`node -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
      encoding: "utf-8",
      timeout: 30000,
      cwd: projectRoot,
    });
    
    const lastLine = result.trim().split('\n').pop() || '[]';
    const files = JSON.parse(lastLine).map((f: string) => 
      path.relative(projectRoot, f)
    );
    
    const timeMs = performance.now() - start;
    return { files: [...new Set(files)], timeMs };
  } catch (error: any) {
    console.error("Semantic search error:", error.message);
    const timeMs = performance.now() - start;
    return { files: [], timeMs };
  }
}

function calculateMetrics(
  foundFiles: string[],
  expectedFiles: string[]
): { precision: number; recall: number; foundExpected: number } {
  const foundSet = new Set(foundFiles);
  const expectedSet = new Set(expectedFiles);
  
  let foundExpected = 0;
  for (const expected of expectedSet) {
    if (foundFiles.some(f => f.includes(expected) || expected.includes(f))) {
      foundExpected++;
    }
  }
  
  const precision = foundFiles.length > 0 ? foundExpected / foundFiles.length : 0;
  const recall = expectedFiles.length > 0 ? foundExpected / expectedFiles.length : 0;
  
  return { precision, recall, foundExpected };
}

async function runBenchmark(projectRoot: string, testQueries: BenchmarkQuery[]): Promise<void> {
  console.log("=" .repeat(70));
  console.log("SEMANTIC SEARCH vs RIPGREP BENCHMARK");
  console.log("=" .repeat(70));
  console.log(`Project: ${projectRoot}`);
  console.log(`Queries: ${testQueries.length}`);
  console.log("");
  
  const semanticResults: SearchResult[] = [];
  const ripgrepResults: SearchResult[] = [];
  
  for (const testQuery of testQueries) {
    process.stdout.write(`Testing: "${testQuery.query.slice(0, 40)}..." `);
    
    const rgResult = runRipgrep(projectRoot, testQuery.query, testQuery.ripgrepTerms);
    const rgMetrics = calculateMetrics(rgResult.files, testQuery.expectedFiles);
    ripgrepResults.push({
      query: testQuery.query,
      method: "ripgrep",
      timeMs: rgResult.timeMs,
      foundFiles: rgResult.files,
      foundExpected: rgMetrics.foundExpected,
      totalExpected: testQuery.expectedFiles.length,
      precision: rgMetrics.precision,
      recall: rgMetrics.recall,
    });
    
    const semResult = await runSemanticSearch(projectRoot, testQuery.query);
    const semMetrics = calculateMetrics(semResult.files, testQuery.expectedFiles);
    semanticResults.push({
      query: testQuery.query,
      method: "semantic",
      timeMs: semResult.timeMs,
      foundFiles: semResult.files,
      foundExpected: semMetrics.foundExpected,
      totalExpected: testQuery.expectedFiles.length,
      precision: semMetrics.precision,
      recall: semMetrics.recall,
    });
    
    console.log("done");
  }
  
  console.log("");
  console.log("-".repeat(70));
  console.log("DETAILED RESULTS");
  console.log("-".repeat(70));
  
  for (let i = 0; i < testQueries.length; i++) {
    const query = testQueries[i];
    const sem = semanticResults[i];
    const rg = ripgrepResults[i];
    
    console.log("");
    console.log(`Query: "${query.query}"`);
    console.log(`Expected: ${query.expectedFiles.join(", ") || "(auto-detect)"}`);
    console.log("");
    console.log(`  Semantic: ${sem.foundExpected}/${sem.totalExpected} found | ${sem.timeMs.toFixed(0)}ms | files: ${sem.foundFiles.join(", ") || "(none)"}`);
    console.log(`  Ripgrep:  ${rg.foundExpected}/${rg.totalExpected} found | ${rg.timeMs.toFixed(0)}ms | files: ${rg.foundFiles.join(", ") || "(none)"}`);
  }
  
  console.log("");
  console.log("=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  
  const semAvgRecall = semanticResults.reduce((a, b) => a + b.recall, 0) / semanticResults.length;
  const rgAvgRecall = ripgrepResults.reduce((a, b) => a + b.recall, 0) / ripgrepResults.length;
  
  const semAvgTime = semanticResults.reduce((a, b) => a + b.timeMs, 0) / semanticResults.length;
  const rgAvgTime = ripgrepResults.reduce((a, b) => a + b.timeMs, 0) / ripgrepResults.length;
  
  const semTotalFound = semanticResults.reduce((a, b) => a + b.foundExpected, 0);
  const rgTotalFound = ripgrepResults.reduce((a, b) => a + b.foundExpected, 0);
  const totalExpected = testQueries.reduce((a, b) => a + b.expectedFiles.length, 0);
  
  console.log("");
  console.log("| Metric              | Semantic Search | Ripgrep  | Winner    |");
  console.log("|---------------------|-----------------|----------|-----------|");
  console.log(`| Avg Recall          | ${(semAvgRecall * 100).toFixed(1).padStart(13)}% | ${(rgAvgRecall * 100).toFixed(1).padStart(6)}% | ${semAvgRecall > rgAvgRecall ? "Semantic" : semAvgRecall < rgAvgRecall ? "Ripgrep" : "Tie"} |`);
  console.log(`| Total Found         | ${String(semTotalFound + "/" + totalExpected).padStart(15)} | ${String(rgTotalFound + "/" + totalExpected).padStart(8)} | ${semTotalFound > rgTotalFound ? "Semantic" : semTotalFound < rgTotalFound ? "Ripgrep" : "Tie"} |`);
  console.log(`| Avg Time            | ${semAvgTime.toFixed(0).padStart(13)}ms | ${rgAvgTime.toFixed(0).padStart(6)}ms | ${semAvgTime < rgAvgTime ? "Semantic" : semAvgTime > rgAvgTime ? "Ripgrep" : "Tie"} |`);
  console.log("");
  
  const semanticWins = semanticResults.filter((s, i) => s.recall > ripgrepResults[i].recall).length;
  const ripgrepWins = ripgrepResults.filter((r, i) => r.recall > semanticResults[i].recall).length;
  const ties = testQueries.length - semanticWins - ripgrepWins;
  
  console.log(`Query wins: Semantic ${semanticWins} | Ripgrep ${ripgrepWins} | Tie ${ties}`);
  console.log("");
  
  console.log("=".repeat(70));
  console.log("TOKEN USAGE COMPARISON");
  console.log("=".repeat(70));
  console.log("");
  
  const tokenUsage = calculateTokenUsage(projectRoot, testQueries.map(q => q.query));
  
  console.log("| Metric                      | Value           |");
  console.log("|-----------------------------|-----------------|");
  console.log(`| Query embedding tokens      | ${String(tokenUsage.queryTokens).padStart(15)} |`);
  console.log(`| Baseline (read all files)   | ${String(tokenUsage.baselineTokens).padStart(15)} |`);
  console.log(`| Tokens saved                | ${String(tokenUsage.savedTokens).padStart(15)} |`);
  console.log(`| Savings                     | ${tokenUsage.savingsPercent.toFixed(1).padStart(14)}% |`);
  console.log("");
  console.log("Note: 'Baseline' simulates sending all source files to LLM for each query.");
  console.log("      Semantic search only embeds the query (~50 tokens) per search.");
  console.log("");
  
  if (semAvgRecall > rgAvgRecall) {
    console.log("CONCLUSION: Semantic search finds more relevant code for natural language queries.");
  } else if (rgAvgRecall > semAvgRecall) {
    console.log("CONCLUSION: Ripgrep keyword search performs better on these queries.");
  } else {
    console.log("CONCLUSION: Both methods perform similarly on these queries.");
  }
  
  console.log(`            Token savings of ${tokenUsage.savingsPercent.toFixed(0)}% vs reading all files.`);
}

// Main
const args = process.argv.slice(2);
let projectRoot = "";
let queriesFile = "";
let autoGenerate = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    printUsage();
    process.exit(0);
  } else if (arg === "--queries" && args[i + 1]) {
    queriesFile = args[++i];
  } else if (arg === "--auto") {
    autoGenerate = true;
  } else if (!arg.startsWith("-")) {
    projectRoot = arg;
  }
}

if (!projectRoot) {
  projectRoot = "/Users/kenneth/dev/git/test";
}

if (!fs.existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

let queries: BenchmarkQuery[];
if (queriesFile) {
  if (!fs.existsSync(queriesFile)) {
    console.error(`Queries file not found: ${queriesFile}`);
    process.exit(1);
  }
  queries = loadQueriesFromFile(queriesFile);
  console.log(`Loaded ${queries.length} queries from ${queriesFile}`);
} else if (autoGenerate) {
  queries = autoGenerateQueries(projectRoot);
  console.log(`Auto-generated ${queries.length} queries based on codebase analysis`);
} else {
  queries = DEFAULT_QUERIES;
}

runBenchmark(projectRoot, queries).catch(console.error);
