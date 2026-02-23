import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { extractCalls, Database, hashContent } from "../src/native/index.js";
import type { SymbolData, CallEdgeData } from "../src/native/index.js";

const fixturesDir = path.join(__dirname, "fixtures", "call-graph");

describe("call-graph", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-graph-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("call extraction", () => {
    it("should extract direct function calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "simple-calls.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("directCall");
      expect(callNames).toContain("helper");
      expect(callNames).toContain("compute");

      const directCall = calls.find((c) => c.calleeName === "directCall");
      expect(directCall).toBeDefined();
      expect(directCall!.callType).toBe("Call");

      const helperCall = calls.find((c) => c.calleeName === "helper");
      expect(helperCall).toBeDefined();
      expect(helperCall!.callType).toBe("Call");
    });

    it("should extract method calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "method-calls.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("validate");
      expect(callNames).toContain("reset");
      expect(callNames).toContain("add");
      expect(callNames).toContain("subtract");
      expect(callNames).toContain("square");
    });

    it("should extract constructor calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "constructors.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const constructorCalls = calls.filter((c) => c.callType === "Constructor");
      const constructorNames = constructorCalls.map((c) => c.calleeName);
      expect(constructorNames).toContain("SimpleClass");
      expect(constructorNames).toContain("ClassWithArgs");
      expect(constructorNames).toContain("NestedConstruction");
      expect(constructorNames).toContain("GenericBox");
    });

    it("should extract imports", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "imports.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const importCalls = calls.filter((c) => c.callType === "Import");
      const importNames = importCalls.map((c) => c.calleeName);
      expect(importNames).toContain("parseFile");
      expect(importNames).toContain("hashContent");
      expect(importNames).toContain("Indexer");
      expect(importNames).toContain("Logger");
      expect(importNames).toContain("Database");
    });

    it("should handle nested calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "nested-calls.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("inner");
      expect(callNames).toContain("middle");
      expect(callNames).toContain("deep");
      expect(callNames).toContain("compute");
      expect(callNames).toContain("transform");
      expect(callNames).toContain("getData");
    });

    it("should handle edge cases", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "edge-cases.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("method");
      expect(callNames).toContain("trueCase");
      expect(callNames).toContain("falseCase");
      expect(callNames).toContain("riskyOperation");
      expect(callNames).toContain("handleError");
      expect(callNames).toContain("cleanup");
      expect(callNames).toContain("fetchData");
    });
  });

  describe("call graph storage", () => {
    it("should store symbols in database", () => {
      const db = new Database(path.join(tempDir, "test.db"));
      const symbols: SymbolData[] = [
        {
          id: "sym_001",
          filePath: "/src/foo.ts",
          name: "fooFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_002",
          filePath: "/src/foo.ts",
          name: "barFunc",
          kind: "function",
          startLine: 12,
          startCol: 0,
          endLine: 20,
          endCol: 0,
          language: "typescript",
        },
      ];

      db.upsertSymbolsBatch(symbols);
      const retrieved = db.getSymbolsByFile("/src/foo.ts");
      expect(retrieved.length).toBe(2);

      const names = retrieved.map((s) => s.name);
      expect(names).toContain("fooFunc");
      expect(names).toContain("barFunc");
    });

    it("should store call edges", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_a",
          filePath: "/src/a.ts",
          name: "caller",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_b",
          filePath: "/src/a.ts",
          name: "callee",
          kind: "function",
          startLine: 12,
          startCol: 0,
          endLine: 20,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_001",
          fromSymbolId: "sym_a",
          targetName: "callee",
          callType: "Call",
          line: 5,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      const callees = db.getCallees("sym_a");
      expect(callees.length).toBe(1);
      expect(callees[0].targetName).toBe("callee");
      expect(callees[0].callType).toBe("Call");
    });

    it("should store branch relationships", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_br1",
          filePath: "/src/x.ts",
          name: "branchFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);
      db.addSymbolsToBranchBatch("main", ["sym_br1"]);

      // Create an edge from sym_br1 targeting "branchFunc" so getCallers can find it
      const edges: CallEdgeData[] = [
        {
          id: "edge_br1",
          fromSymbolId: "sym_br1",
          targetName: "branchFunc",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // getCallers filters by branch
      const callers = db.getCallers("branchFunc", "main");
      expect(callers.length).toBe(1);
      expect(callers[0].fromSymbolId).toBe("sym_br1");
    });
  });

  describe("call resolution", () => {
    it("should resolve same-file calls", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_caller",
          filePath: "/src/file.ts",
          name: "caller",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_target",
          filePath: "/src/file.ts",
          name: "target",
          kind: "function",
          startLine: 7,
          startCol: 0,
          endLine: 12,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_resolve",
          fromSymbolId: "sym_caller",
          targetName: "target",
          callType: "Call",
          line: 3,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Resolve the edge
      db.resolveCallEdge("edge_resolve", "sym_target");

      // Verify resolution
      const callees = db.getCallees("sym_caller");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_target");
    });

    it("should leave cross-file calls unresolved", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_local",
          filePath: "/src/local.ts",
          name: "localFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_cross",
          fromSymbolId: "sym_local",
          targetName: "externalFunc",
          callType: "Import",
          line: 1,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Don't resolve — it's cross-file
      const callees = db.getCallees("sym_local");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(false);
      expect(callees[0].toSymbolId).toBeUndefined();
    });

    it("should handle multiple targets with same name", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_caller_m",
          filePath: "/src/main.ts",
          name: "main",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_helper_a",
          filePath: "/src/a.ts",
          name: "helper",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_helper_b",
          filePath: "/src/b.ts",
          name: "helper",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_multi",
          fromSymbolId: "sym_caller_m",
          targetName: "helper",
          callType: "Call",
          line: 5,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Resolve to only one of the targets
      db.resolveCallEdge("edge_multi", "sym_helper_a");

      const callees = db.getCallees("sym_caller_m");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_helper_a");
    });
  });

  describe("branch awareness", () => {
    it("should filter symbols by current branch", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_main_1",
          filePath: "/src/main.ts",
          name: "mainFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_feat_1",
          filePath: "/src/feat.ts",
          name: "featFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      db.addSymbolsToBranchBatch("main", ["sym_main_1"]);
      db.addSymbolsToBranchBatch("feature", ["sym_feat_1"]);

      // Create edges so getCallers can find them
      const edges: CallEdgeData[] = [
        {
          id: "edge_main_1",
          fromSymbolId: "sym_main_1",
          targetName: "mainFunc",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
        {
          id: "edge_feat_1",
          fromSymbolId: "sym_feat_1",
          targetName: "featFunc",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Query with branch "main" should only return main symbols
      const mainCallers = db.getCallers("mainFunc", "main");
      expect(mainCallers.length).toBe(1);
      expect(mainCallers[0].fromSymbolId).toBe("sym_main_1");

      // Query with branch "main" should not return feature symbols
      const featOnMain = db.getCallers("featFunc", "main");
      expect(featOnMain.length).toBe(0);
    });

    it("should filter call edges by branch", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_br_a",
          filePath: "/src/a.ts",
          name: "funcA",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_br_b",
          filePath: "/src/b.ts",
          name: "funcB",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      db.addSymbolsToBranchBatch("main", ["sym_br_a"]);
      db.addSymbolsToBranchBatch("other", ["sym_br_b"]);

      const edges: CallEdgeData[] = [
        {
          id: "edge_ba",
          fromSymbolId: "sym_br_a",
          targetName: "sharedTarget",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
        {
          id: "edge_bb",
          fromSymbolId: "sym_br_b",
          targetName: "sharedTarget",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Only sym_br_a is on "main"
      const mainCallers = db.getCallers("sharedTarget", "main");
      expect(mainCallers.length).toBe(1);
      expect(mainCallers[0].fromSymbolId).toBe("sym_br_a");

      // Only sym_br_b is on "other"
      const otherCallers = db.getCallers("sharedTarget", "other");
      expect(otherCallers.length).toBe(1);
      expect(otherCallers[0].fromSymbolId).toBe("sym_br_b");
    });
  });

  describe("integration", () => {
    it("should build complete call graph for simple project", () => {
      const db = new Database(path.join(tempDir, "test.db"));
      const content = fs.readFileSync(path.join(fixturesDir, "same-file-refs.ts"), "utf-8");
      const filePath = path.join(fixturesDir, "same-file-refs.ts");

      // Extract calls
      const callSites = extractCalls(content, "typescript");
      expect(callSites.length).toBeGreaterThan(0);

      // Build symbols from known functions in the fixture
      const functionDefs = [
        { name: "entryPoint", startLine: 5, endLine: 13 },
        { name: "helperA", startLine: 15, endLine: 18 },
        { name: "helperB", startLine: 20, endLine: 22 },
        { name: "internalUtil", startLine: 24, endLine: 26 },
        { name: "MyClass", startLine: 28, endLine: 41 },
        { name: "outerScope", startLine: 54, endLine: 60 },
        { name: "fibonacci", startLine: 63, endLine: 66 },
        { name: "evenOdd", startLine: 68, endLine: 71 },
        { name: "isOdd", startLine: 73, endLine: 76 },
        { name: "exported", startLine: 79, endLine: 81 },
      ];

      const symbols: SymbolData[] = functionDefs.map((def) => ({
        id: `sym_${hashContent(filePath + ":" + def.name + ":function:" + def.startLine).slice(0, 16)}`,
        filePath,
        name: def.name,
        kind: "function",
        startLine: def.startLine,
        startCol: 0,
        endLine: def.endLine,
        endCol: 0,
        language: "typescript",
      }));

      db.upsertSymbolsBatch(symbols);

      // Build edges from call sites
      const edges: CallEdgeData[] = [];
      for (const site of callSites) {
        const enclosing = symbols.find(
          (sym) => site.line >= sym.startLine && site.line <= sym.endLine
        );
        if (!enclosing) continue;

        const edgeId = `edge_${hashContent(enclosing.id + ":" + site.calleeName + ":" + site.line + ":" + site.column).slice(0, 16)}`;
        edges.push({
          id: edgeId,
          fromSymbolId: enclosing.id,
          targetName: site.calleeName,
          callType: site.callType,
          line: site.line,
          col: site.column,
          isResolved: false,
        });
      }

      expect(edges.length).toBeGreaterThan(0);
      db.upsertCallEdgesBatch(edges);

      // Resolve same-file calls
      for (const edge of edges) {
        const matchingSymbol = symbols.find((sym) => sym.name === edge.targetName);
        if (matchingSymbol) {
          db.resolveCallEdge(edge.id, matchingSymbol.id);
        }
      }

      // Add symbols to branch
      db.addSymbolsToBranchBatch("main", symbols.map((s) => s.id));

      // Verify: helperA should be called by entryPoint, arrowFunc, outerScope (innerScope), exported
      const helperACallers = db.getCallers("helperA", "main");
      expect(helperACallers.length).toBeGreaterThan(0);

      // Verify: helperB should be called by entryPoint and helperA
      const helperBCallers = db.getCallers("helperB", "main");
      expect(helperBCallers.length).toBeGreaterThan(0);

      // Verify entryPoint's callees
      const entryPointSymbol = symbols.find((s) => s.name === "entryPoint");
      expect(entryPointSymbol).toBeDefined();
      const entryCallees = db.getCallees(entryPointSymbol!.id);
      expect(entryCallees.length).toBeGreaterThan(0);

      const entryCalleeNames = entryCallees.map((e) => e.targetName);
      expect(entryCalleeNames).toContain("helperA");
      expect(entryCalleeNames).toContain("helperB");

      // Verify resolved edges have toSymbolId set
      const resolvedCallees = entryCallees.filter((e) => e.isResolved);
      expect(resolvedCallees.length).toBeGreaterThan(0);
      for (const resolved of resolvedCallees) {
        expect(resolved.toSymbolId).toBeDefined();
      }
    });
  });
});
