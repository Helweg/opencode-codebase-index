import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { extractCalls, Database, hashContent, parseFiles } from "../src/native/index.js";
import type { SymbolData, CallEdgeData } from "../src/native/index.js";
import {
  CALL_GRAPH_LANGUAGES,
  CALL_GRAPH_SYMBOL_CHUNK_TYPES,
  CASE_INSENSITIVE_LANGUAGES,
} from "../src/indexer/index.js";

const fixturesDir = path.join(__dirname, "fixtures", "call-graph");

describe("call-graph", () => {
  let tempDir: string;
  let _dbs: Database[] = [];

  function openDb(): Database {
    const d = new Database(path.join(tempDir, "test.db"));
    _dbs.push(d);
    return d;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-graph-test-"));
    _dbs = [];
  });

  afterEach(() => {
    _dbs.forEach((d) => d.close());
    _dbs = [];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

 describe("call extraction", () => {
     it("should extract method calls", () => {
          const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
          const calls = extractCalls(content, "php");

          const methodCalls = calls.filter((c) => c.callType === "MethodCall");
          const methodNames = methodCalls.map((c) => c.calleeName);
          expect(methodNames).toContain("validate");
          expect(methodNames).toContain("add");
          expect(methodNames).toContain("subtract");
        });

        it("should extract nullsafe method calls", () => {
          const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
          const calls = extractCalls(content, "php");

          const resetCall = calls.find((c) => c.calleeName === "reset");
          expect(resetCall).toBeDefined();
          expect(resetCall!.callType).toBe("MethodCall");
        });

        it("should extract static method calls", () => {
          const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
          const calls = extractCalls(content, "php");

          const createCall = calls.find((c) => c.calleeName === "create");
          expect(createCall).toBeDefined();
          expect(createCall!.callType).toBe("MethodCall");
        });

        it("should detect method calls using zero-allocation approach", () => {
          const content = fs.readFileSync(path.join(fixturesDir, "php-method-zeroalloc.php"), "utf-8");
          const calls = extractCalls(content, "php");

          // Check that method calls are correctly identified without using parent() on callee.name
          const methodCalls = calls.filter((c) => c.callType === "MethodCall");
          expect(methodCalls.length).toBeGreaterThan(0);

          // Verify specific method call patterns
          expect(methodCalls.some(c => c.calleeName === "process")).toBe(true);
          expect(methodCalls.some(c => c.calleeName === "validate")).toBe(true);
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

    describe("php call extraction", () => {
      it("should extract direct function calls", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-simple-calls.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const callNames = calls.map((c) => c.calleeName);
        expect(callNames).toContain("directcall");
        expect(callNames).toContain("helper");
        expect(callNames).toContain("compute");

        const directCall = calls.find((c) => c.calleeName === "directcall");
        expect(directCall).toBeDefined();
        expect(directCall!.callType).toBe("Call");
      });

      it("should normalize PHP function names to lowercase", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-simple-calls.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const helperCalls = calls.filter((c) => c.calleeName === "helper" && c.callType === "Call");
        expect(helperCalls.length).toBe(2);
      });

      it("should extract method calls", () => {
         const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
         const calls = extractCalls(content, "php");

         const methodCalls = calls.filter((c) => c.callType === "MethodCall");
         const methodNames = methodCalls.map((c) => c.calleeName);
         expect(methodNames).toContain("validate");
         expect(methodNames).toContain("add");
         expect(methodNames).toContain("subtract");
       });

     it("should extract nullsafe method calls", () => {
         const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
         const calls = extractCalls(content, "php");

         const resetCall = calls.find((c) => c.calleeName === "reset");
         expect(resetCall).toBeDefined();
         expect(resetCall!.callType).toBe("MethodCall");
      });

      it("should extract static method calls", () => {
         const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
         const calls = extractCalls(content, "php");

         const createCall = calls.find((c) => c.calleeName === "create");
         expect(createCall).toBeDefined();
         expect(createCall!.callType).toBe("MethodCall");
      });

      it("should extract constructor calls", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-constructors.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const constructorCalls = calls.filter((c) => c.callType === "Constructor");
        const constructorNames = constructorCalls.map((c) => c.calleeName);
        expect(constructorNames).toContain("SimpleClass");
        expect(constructorNames).toContain("ClassWithArgs");
      });

      it("should extract use imports", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-imports.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const importCalls = calls.filter((c) => c.callType === "Import");
        const importNames = importCalls.map((c) => c.calleeName);
        expect(importNames).toContain("User");
        expect(importNames).toContain("AuthService");
      });

      it("should extract grouped use imports", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-imports.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const importCalls = calls.filter((c) => c.callType === "Import");
        const importNames = importCalls.map((c) => c.calleeName);
        expect(importNames).toContain("StringHelper");
        expect(importNames).toContain("ArrayHelper");
      });
    });

    describe("apex call extraction", () => {
      it("should extract direct function calls", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-simple-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        const callNames = calls.map((c) => c.calleeName);
        expect(callNames).toContain("directcall");
        expect(callNames).toContain("helper");
        expect(callNames).toContain("compute");

        const directCall = calls.find((c) => c.calleeName === "directcall");
        expect(directCall).toBeDefined();
        expect(directCall!.callType).toBe("Call");
      });

      it("should normalize Apex function names to lowercase (case-insensitive language)", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-simple-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        // Both `helper(...)` invocations + `HELPER()` invocation should normalize to `helper`.
        const helperCalls = calls.filter(
          (c) => c.calleeName === "helper" && c.callType === "Call",
        );
        expect(helperCalls.length).toBe(3);

        // `MyFunc()` should normalize to `myfunc`.
        const myFuncCall = calls.find((c) => c.calleeName === "myfunc");
        expect(myFuncCall).toBeDefined();
        expect(myFuncCall!.callType).toBe("Call");
      });

      it("should extract method calls", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-method-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        const methodCalls = calls.filter((c) => c.callType === "MethodCall");
        const methodNames = methodCalls.map((c) => c.calleeName);
        expect(methodNames).toContain("validate");
        expect(methodNames).toContain("add");
        expect(methodNames).toContain("subtract");
        expect(methodNames).toContain("cleanup");
      });

      it("should extract static method calls as method calls", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-method-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        // Apex grammar produces method_invocation with object field for both
        // instance and static calls; we report both as MethodCall.
        const staticDo = calls.find((c) => c.calleeName === "staticdo");
        expect(staticDo).toBeDefined();
        expect(staticDo!.callType).toBe("MethodCall");
      });

      it("should extract chained method calls with case normalization", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-method-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        // Foo.Bar.DeepCall() → method_invocation with object=field_access(Foo.Bar)
        // and name=DeepCall, normalized to lowercase.
        const deepCall = calls.find((c) => c.calleeName === "deepcall");
        expect(deepCall).toBeDefined();
        expect(deepCall!.callType).toBe("MethodCall");

        // Method() should also normalize
        const methodCall = calls.find(
          (c) => c.calleeName === "method" && c.callType === "MethodCall",
        );
        expect(methodCall).toBeDefined();
      });

      it("should extract constructor calls preserving original case", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-constructors.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        const constructorCalls = calls.filter(
          (c) => c.callType === "Constructor",
        );
        const constructorNames = constructorCalls.map((c) => c.calleeName);
        // Constructor names keep original casing (they need to match
        // class_declaration symbols which use exact-case names).
        expect(constructorNames).toContain("Account");
        expect(constructorNames).toContain("SimpleClass");
        expect(constructorNames).toContain("ClassWithArgs");
      });

      it("should not produce import edges (Apex has no imports)", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-method-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        const importCalls = calls.filter((c) => c.callType === "Import");
        expect(importCalls.length).toBe(0);
      });
    });

    describe("matlab call extraction", () => {
      const content = `function score = calculateSignal(model, prices)
    returns = diff(log(prices));
    normalized = SignalUtils.normalize(returns);
    score = model.score(normalized) + helper(normalized);
    first = prices(1);
end

function value = helper(values)
    value = mean(values) / std(values);
end
`;

      it("should extract direct function calls", () => {
        const calls = extractCalls(content, "matlab");
        const callNames = calls.map((c) => c.calleeName);

        expect(callNames).toContain("diff");
        expect(callNames).toContain("log");
        expect(callNames).toContain("helper");
        expect(callNames).toContain("mean");
        expect(callNames).toContain("std");
      });

      it("should extract method and package calls", () => {
        const calls = extractCalls(content, "matlab");

        const normalizeCall = calls.find((c) => c.calleeName === "normalize");
        expect(normalizeCall).toBeDefined();
        expect(normalizeCall!.callType).toBe("MethodCall");

        const scoreCall = calls.find((c) => c.calleeName === "score");
        expect(scoreCall).toBeDefined();
        expect(scoreCall!.callType).toBe("MethodCall");
      });

      it("should document indexing syntax ambiguity", () => {
        const calls = extractCalls(content, "matlab");
        const pricesCall = calls.find((c) => c.calleeName === "prices");

        expect(pricesCall).toBeDefined();
        expect(pricesCall!.callType).toBe("Call");
      });

      it("should produce edges owned by MATLAB function symbols", () => {
        expect(CALL_GRAPH_LANGUAGES.has("matlab")).toBe(true);

        const filePath = path.join(tempDir, "calculateSignal.m");
        const parsed = parseFiles([{ path: filePath, content }]);
        expect(parsed.length).toBe(1);

        const fileSymbols: SymbolData[] = [];
        for (const chunk of parsed[0].chunks) {
          if (!chunk.name || !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)) continue;
          fileSymbols.push({
            id: `sym_${hashContent(filePath + ":" + chunk.name + ":" + chunk.chunkType + ":" + chunk.startLine).slice(0, 16)}`,
            filePath,
            name: chunk.name,
            kind: chunk.chunkType,
            startLine: chunk.startLine,
            startCol: 0,
            endLine: chunk.endLine,
            endCol: 0,
            language: chunk.language,
          });
        }

        expect(fileSymbols.length).toBeGreaterThan(0);
        expect(fileSymbols.some((s) => s.name === "calculateSignal")).toBe(true);
        expect(fileSymbols.some((s) => s.name === "helper")).toBe(true);

        const calls = extractCalls(content, "matlab");
        const ownedCalls = calls.filter((site) =>
          fileSymbols.some(
            (sym) => site.line >= sym.startLine && site.line <= sym.endLine,
          ),
        );
        expect(ownedCalls.length).toBe(calls.length);
      });
    });
  });

  describe("apex trigger call graph", () => {
    it("should treat trigger_declaration as a valid call graph symbol type", () => {
      // Regression test for PR #68 review: without trigger_declaration in
      // CALL_GRAPH_SYMBOL_CHUNK_TYPES, calls inside .trigger files were
      // silently dropped because no enclosing symbol could be found.
      expect(CALL_GRAPH_SYMBOL_CHUNK_TYPES.has("trigger_declaration")).toBe(true);
    });

    it("should produce edges for calls inside Apex triggers", () => {
      const triggerContent = `trigger AccountTrigger on Account (before insert, before update) {
    AccountService.process(Trigger.new);
    helper(Trigger.newMap);
}
`;
      const triggerPath = path.join(tempDir, "AccountTrigger.trigger");
      fs.writeFileSync(triggerPath, triggerContent, "utf-8");

      const parsed = parseFiles([{ path: triggerPath, content: triggerContent }]);
      expect(parsed.length).toBe(1);

      // Apply the same filter the Indexer uses to build symbols.
      const fileSymbols: SymbolData[] = [];
      for (const chunk of parsed[0].chunks) {
        if (!chunk.name || !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)) continue;
        fileSymbols.push({
          id: `sym_${hashContent(triggerPath + ":" + chunk.name + ":" + chunk.chunkType + ":" + chunk.startLine).slice(0, 16)}`,
          filePath: triggerPath,
          name: chunk.name,
          kind: chunk.chunkType,
          startLine: chunk.startLine,
          startCol: 0,
          endLine: chunk.endLine,
          endCol: 0,
          language: chunk.language,
        });
      }

      // The trigger itself must produce a symbol; otherwise call sites would
      // be dropped at the enclosingSymbol step.
      expect(fileSymbols.length).toBeGreaterThan(0);
      const triggerSymbol = fileSymbols.find((s) => s.kind === "trigger_declaration");
      expect(triggerSymbol).toBeDefined();
      expect(triggerSymbol!.name).toBe("AccountTrigger");

      // Extract call sites and confirm each one resolves to an enclosing symbol
      // (i.e. the trigger), so the Indexer would actually persist the edges.
      const calls = extractCalls(triggerContent, "apex");
      expect(calls.length).toBeGreaterThan(0);

      const enclosedCalls = calls.filter((site) =>
        fileSymbols.some(
          (sym) => site.line >= sym.startLine && site.line <= sym.endLine,
        ),
      );
      expect(enclosedCalls.length).toBe(calls.length);

      // Sanity: at least one of the calls is the helper() direct call inside the trigger.
      expect(calls.some((c) => c.calleeName === "helper")).toBe(true);
    });
  });

  describe("apex same-file case-insensitive resolution", () => {
    it("should declare apex as a case-insensitive language", () => {
      // The Rust call_extractor lowercases Apex callee names; the Indexer
      // must use the same normalization when resolving same-file calls.
      expect(CASE_INSENSITIVE_LANGUAGES.has("apex")).toBe(true);
    });

    it("should resolve a same-file Apex call when caller and callee differ in case", () => {
      // Regression test for PR #68 review: previously, declaring `processOrder`
      // and calling `PROCESSORDER()` left toSymbolId NULL because the lookup
      // was case-sensitive while the call edge's targetName was already
      // lowercased by the Rust extractor.
      //
      // We declare the methods as method-level symbols directly (the same
      // scenario that occurs when the Indexer chunks larger Apex classes into
      // method_declaration chunks via split_large_chunk) and then exercise
      // the same lookup path the Indexer uses.
      const apexContent = `public class CaseTest {
    public void caller() {
        PROCESSORDER();
    }
    public void processOrder() {
        Integer x = 1;
    }
}
`;
      const filePath = path.join(tempDir, "CaseTest.cls");

      // Verify the Rust extractor produces the lowercased target the Indexer
      // would persist on the call edge.
      const callSites = extractCalls(apexContent, "apex");
      const processOrderCall = callSites.find((c) => c.calleeName === "processorder");
      expect(processOrderCall).toBeDefined();

      const fileSymbols: SymbolData[] = [
        {
          id: "sym_case_caller",
          filePath,
          name: "caller",
          kind: "method_declaration",
          startLine: 2,
          startCol: 0,
          endLine: 4,
          endCol: 0,
          language: "apex",
        },
        {
          id: "sym_case_target",
          filePath,
          name: "processOrder", // mixed case declaration
          kind: "method_declaration",
          startLine: 5,
          startCol: 0,
          endLine: 7,
          endCol: 0,
          language: "apex",
        },
      ];

      // Replicate the Indexer's same-file resolution logic verbatim, using
      // the exported case-insensitivity invariant.
      const isCaseInsensitive = CASE_INSENSITIVE_LANGUAGES.has("apex");
      expect(isCaseInsensitive).toBe(true);
      const normalizeKey = (s: string) => (isCaseInsensitive ? s.toLowerCase() : s);

      const symbolsByName = new Map<string, SymbolData[]>();
      for (const sym of fileSymbols) {
        const key = normalizeKey(sym.name);
        const list = symbolsByName.get(key) ?? [];
        list.push(sym);
        symbolsByName.set(key, list);
      }

      // The crux of the bug: this lookup must succeed even though the symbol
      // was declared as `processOrder` and the edge target is `processorder`.
      const candidates = symbolsByName.get(normalizeKey(processOrderCall!.calleeName));
      expect(candidates).toBeDefined();
      expect(candidates!.length).toBe(1);
      expect(candidates![0].name).toBe("processOrder");

      // Persist and resolve through a real Database to confirm end-to-end behavior.
      const db = new Database(path.join(tempDir, "case.db"));
      _dbs.push(db);
      db.upsertSymbolsBatch(fileSymbols);

      const edge: CallEdgeData = {
        id: "edge_case_insensitive",
        fromSymbolId: "sym_case_caller",
        targetName: processOrderCall!.calleeName,
        callType: processOrderCall!.callType,
        line: processOrderCall!.line,
        col: processOrderCall!.column,
        isResolved: false,
      };
      db.upsertCallEdgesBatch([edge]);
      db.resolveCallEdge(edge.id, candidates![0].id);

      db.addSymbolsToBranchBatch(
        "test",
        fileSymbols.map((s) => s.id),
      );
      const callees = db.getCallees("sym_case_caller", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_case_target");
    });
  });

  describe("zig call extraction", () => {
    it("should extract direct function calls", () => {
      const content = `
const std = @import("std");

pub fn greet(name: []const u8) void {
    std.debug.print("Hello, {s}\\n", .{name});
}

pub fn main() void {
    greet("world");
}
`;
      const calls = extractCalls(content, "zig");
      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("greet");
    });

    it("should classify field-access calls as MethodCall", () => {
      const content = `
const std = @import("std");

pub fn greet(name: []const u8) void {
    std.debug.print("Hello, {s}\\n", .{name});
}
`;
      const calls = extractCalls(content, "zig");
      const printCall = calls.find((c) => c.calleeName === "print");
      expect(printCall).toBeDefined();
      expect(printCall!.callType).toBe("MethodCall");
    });

    it("should extract @import builtins as import edges", () => {
      const content = `
const std = @import("std");
const math = @import("math.zig");
`;
      const calls = extractCalls(content, "zig");
      const importCalls = calls.filter((c) => c.callType === "Import");
      expect(importCalls.length).toBeGreaterThanOrEqual(2);
      expect(importCalls.some((c) => c.calleeName.includes("std"))).toBe(true);
      expect(importCalls.some((c) => c.calleeName.includes("math.zig"))).toBe(true);
    });
  });

  describe("call graph storage", () => {
    it("should store symbols in database", () => {
      const db = openDb();
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

      const byName = db.getSymbolsByName("fooFunc");
      expect(byName.length).toBe(1);
      expect(byName[0]?.filePath).toBe("/src/foo.ts");

      const byNameCi = db.getSymbolsByNameCi("foofunc");
      expect(byNameCi.length).toBe(1);
      expect(byNameCi[0]?.filePath).toBe("/src/foo.ts");
    });

    it("should store call edges", () => {
      const db = openDb();

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

      db.addSymbolsToBranchBatch("test", ["sym_a", "sym_b"]);
      const callees = db.getCallees("sym_a", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].targetName).toBe("callee");
      expect(callees[0].callType).toBe("Call");
    });

    it("should store branch relationships", () => {
      const db = openDb();

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
      const db = openDb();

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
      db.addSymbolsToBranchBatch("test", ["sym_caller", "sym_target"]);
      const callees = db.getCallees("sym_caller", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_target");
    });

    it("should leave cross-file calls unresolved", () => {
      const db = openDb();

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
      db.addSymbolsToBranchBatch("test", ["sym_local"]);
      const callees = db.getCallees("sym_local", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(false);
      expect(callees[0].toSymbolId).toBeUndefined();
    });

    it("should handle multiple targets with same name", () => {
      const db = openDb();

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

      db.addSymbolsToBranchBatch("test", ["sym_caller_m", "sym_helper_a", "sym_helper_b"]);
      const callees = db.getCallees("sym_caller_m", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_helper_a");
    });

    it("should keep ambiguous same-file target unresolved", () => {
      const db = openDb();

      const symbols: SymbolData[] = [
        {
          id: "sym_caller_amb",
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
          id: "sym_dup_1",
          filePath: "/src/file.ts",
          name: "dup",
          kind: "function",
          startLine: 7,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_dup_2",
          filePath: "/src/file.ts",
          name: "dup",
          kind: "function",
          startLine: 12,
          startCol: 0,
          endLine: 15,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_ambiguous",
          fromSymbolId: "sym_caller_amb",
          targetName: "dup",
          callType: "Call",
          line: 3,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      db.addSymbolsToBranchBatch("test", ["sym_caller_amb", "sym_dup_1", "sym_dup_2"]);
      const callees = db.getCallees("sym_caller_amb", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(false);
      expect(callees[0].toSymbolId).toBeUndefined();
    });
  });

  describe("branch awareness", () => {
    it("should filter symbols by current branch", () => {
      const db = openDb();

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
      const db = openDb();

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
      const db = openDb();
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
      const entryCallees = db.getCallees(entryPointSymbol!.id, "main");
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
