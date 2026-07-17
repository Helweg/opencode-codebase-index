import type { ChildProcess } from "child_process";
import type { AddressInfo } from "net";
import { fork } from "child_process";
import * as fs from "fs";
import { createServer, type Server, type ServerResponse } from "http";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { acquireIndexLock, releaseIndexLock } from "../src/indexer/index-lock.js";
import { Database, InvertedIndex, VectorStore } from "../src/native/index.js";

interface WorkerMessage {
  type: string;
  ok?: boolean;
  code?: string;
  pid?: number;
  stats?: { indexedChunks?: number };
  owner?: { pid?: number; token?: string };
  message?: string;
}

class WorkerController {
  readonly child: ChildProcess;
  readonly messages: WorkerMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: WorkerMessage) => boolean;
    resolve: (message: WorkerMessage) => void;
  }> = [];
  private readonly output: string[] = [];

  constructor(projectRoot: string, baseUrl: string) {
    const workerPath = fileURLToPath(new URL("./fixtures/multiprocess-index-worker.ts", import.meta.url));
    this.child = fork(workerPath, [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        TEST_PROJECT_ROOT: projectRoot,
        TEST_EMBEDDING_BASE_URL: baseUrl,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child.stdout?.on("data", (chunk) => this.output.push(String(chunk)));
    this.child.stderr?.on("data", (chunk) => this.output.push(String(chunk)));
    this.child.on("message", (message: WorkerMessage) => {
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
  }

  send(message: Record<string, unknown>): void {
    if (!this.child.connected) return;
    this.child.send(message, (error) => {
      if (error && !["EPIPE", "ERR_IPC_CHANNEL_CLOSED"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        this.output.push(String(error));
      }
    });
  }

  async waitFor(predicate: (message: WorkerMessage) => boolean, timeoutMs = 5000): Promise<WorkerMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Worker timeout. Messages: ${JSON.stringify(this.messages)}\n${this.output.join("")}`));
      }, timeoutMs);
      const originalResolve = waiter.resolve;
      waiter.resolve = (message) => {
        clearTimeout(timeout);
        originalResolve(message);
      };
    });
  }

  async waitForReady(): Promise<void> {
    await this.waitFor((message) => message.type === "ready");
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.send({ type: "stop" });
    await this.waitForExit(1500).catch(() => {
      this.child.kill("SIGKILL");
    });
    await this.waitForExit();
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.waitForExit();
  }

  async waitForExit(timeoutMs = 5000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker did not exit")), timeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

class FakeEmbeddingServer {
  private server: Server | null = null;
  private blocked = false;
  private pendingResponses: Array<() => void> = [];
  private countWaiters: Array<{ count: number; resolve: () => void }> = [];
  requestCount = 0;
  active = 0;
  maxActive = 0;
  inputs: string[] = [];

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/embeddings") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => { void this.respond(body, response); });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  }

  get baseUrl(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error("Server is not listening");
    return `http://127.0.0.1:${address.port}/v1`;
  }

  block(): void {
    this.blocked = true;
  }

  release(): void {
    this.blocked = false;
    for (const resolve of this.pendingResponses.splice(0)) resolve();
  }

  reset(): void {
    if (this.active !== 0) throw new Error("Cannot reset with active requests");
    this.requestCount = 0;
    this.maxActive = 0;
    this.inputs = [];
  }

  async waitForRequestCount(count: number, timeoutMs = 5000): Promise<void> {
    if (this.requestCount >= count) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = { count, resolve };
      this.countWaiters.push(waiter);
      const timeout = setTimeout(() => {
        const index = this.countWaiters.indexOf(waiter);
        if (index >= 0) this.countWaiters.splice(index, 1);
        reject(new Error(`Expected ${count} requests, received ${this.requestCount}`));
      }, timeoutMs);
      waiter.resolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  async waitForIdle(timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (this.active > 0) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`Server still has ${this.active} active requests`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async close(): Promise<void> {
    this.release();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async respond(body: string, response: ServerResponse): Promise<void> {
    const parsed = JSON.parse(body) as { input?: unknown };
    const requestInputs = Array.isArray(parsed.input) ? parsed.input.map(String) : [String(parsed.input ?? "")];
    this.inputs.push(...requestInputs);
    this.requestCount += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    for (const waiter of [...this.countWaiters]) {
      if (this.requestCount < waiter.count) continue;
      this.countWaiters.splice(this.countWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.active -= 1;
    };
    response.once("close", finish);

    if (this.blocked) await new Promise<void>((resolve) => this.pendingResponses.push(resolve));
    if (response.destroyed) {
      finish();
      return;
    }

    const data = requestInputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: 8 }, (_, dimension) => ((input.length + dimension * 17) % 97) / 97),
    }));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data, usage: { total_tokens: requestInputs.length } }), finish);
  }
}

describe("multiprocess indexing", () => {
  let tempDir: string;
  let projectRoot: string;
  let sourcePath: string;
  let embeddingServer: FakeEmbeddingServer;
  let workers: WorkerController[];
  let mcpClients: Client[];
  let localIndexers: Indexer[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiprocess-index-"));
    projectRoot = path.join(tempDir, "project");
    sourcePath = path.join(projectRoot, "src", "index.ts");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "fixture" }));
    fs.writeFileSync(sourcePath, "export function alpha() { return 'alpha'; }\nexport function beta() { return alpha(); }\n");
    embeddingServer = new FakeEmbeddingServer();
    await embeddingServer.start();
    workers = [];
    mcpClients = [];
    localIndexers = [];
  });

  afterEach(async () => {
    embeddingServer?.release();
    await Promise.all((mcpClients ?? []).map((client) => client.close().catch(() => {})));
    await Promise.all((workers ?? []).map((worker) => worker.stop()));
    await Promise.all((localIndexers ?? []).map((indexer) => indexer.close().catch(() => {})));
    await embeddingServer?.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function createWorker(): Promise<WorkerController> {
    const worker = new WorkerController(projectRoot, embeddingServer.baseUrl);
    workers.push(worker);
    await worker.waitForReady();
    return worker;
  }

  async function createMcpClient(configPath: string): Promise<{
    client: Client;
    transport: StdioClientTransport;
    stderr: string[];
  }> {
    const stderr: string[] = [];
    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", cliPath, "--project", projectRoot, "--config", configPath, "--host", "opencode"],
      cwd: path.dirname(cliPath),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const client = new Client({ name: "multiprocess-test-client", version: "1.0.0" });
    mcpClients.push(client);
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`MCP client failed to connect: ${stderr.join("")}`, { cause: error });
    }
    return { client, transport, stderr };
  }

  async function seedIndex(): Promise<void> {
    const worker = await createWorker();
    worker.send({ type: "run", operation: "index" });
    const result = await worker.waitFor((message) => message.type === "result");
    expect(result.ok).toBe(true);
    await worker.waitForExit();
    await embeddingServer.waitForIdle();
  }

  function createLocalIndexer(autoGc = false): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      scope: "project",
      customProvider: {
        baseUrl: embeddingServer.baseUrl,
        model: "multiprocess-test",
        dimensions: 8,
        timeoutMs: 5000,
        maxBatchSize: 64,
        concurrency: 1,
        requestIntervalMs: 0,
      },
      include: ["**/*.ts"],
      exclude: ["**/.opencode/**", "**/.git/**", "**/node_modules/**"],
      indexing: {
        autoIndex: false,
        watchFiles: false,
        autoGc,
        retries: 0,
        retryDelayMs: 1,
        gitBlame: { enabled: false },
      },
      debug: { enabled: false },
    });
    const indexer = new Indexer(projectRoot, config);
    localIndexers.push(indexer);
    return indexer;
  }

  function readOwner(): string {
    return fs.readFileSync(path.join(projectRoot, ".opencode", "index", "indexing.lock", "owner.json"), "utf-8");
  }

  function assertIndexIntegrity(): void {
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const database = new Database(path.join(indexPath, "codebase.db"));
    const stats = database.getStats();
    const branchChunkIds = database.getBranchChunkIds("default");
    expect(stats?.chunkCount).toBeGreaterThan(0);
    expect(stats?.embeddingCount).toBeGreaterThan(0);
    expect(stats?.branchChunkCount).toBe(branchChunkIds.length);
    expect(branchChunkIds.length).toBe(stats?.chunkCount);
    for (const chunkId of branchChunkIds) {
      const chunk = database.getChunk(chunkId);
      expect(chunk).not.toBeNull();
      expect(database.getEmbedding(chunk!.contentHash)).not.toBeNull();
    }
    database.close();

    const vectors = new VectorStore(path.join(indexPath, "vectors"), 8);
    vectors.load();
    expect(vectors.count()).toBe(stats?.chunkCount);
    expect(vectors.getAllMetadata().map(({ key }) => key).sort()).toEqual([...branchChunkIds].sort());

    const inverted = new InvertedIndex(path.join(indexPath, "inverted-index.json"));
    inverted.load();
    expect(inverted.getDocumentCount()).toBe(stats?.chunkCount);
    expect(Array.from(inverted.search("function", 20).keys()).some((chunkId) => branchChunkIds.includes(chunkId))).toBe(true);
    const hashes = JSON.parse(fs.readFileSync(path.join(indexPath, "file-hashes.json"), "utf-8")) as Record<string, string>;
    expect(Object.keys(hashes).length).toBeGreaterThan(0);
    expect(hashes[sourcePath]).toBeTypeOf("string");
    expect(fs.existsSync(path.join(indexPath, "failed-batches.json"))).toBe(false);
    expect(fs.existsSync(path.join(indexPath, "indexing.lock"))).toBe(false);
    expect(fs.readdirSync(indexPath).some((name) => name.includes(".tmp.") || name.includes(".bak.") || name.startsWith("indexing.lock."))).toBe(false);
  }

  it("allows only one normal indexer to embed", async () => {
    embeddingServer.block();
    const first = await createWorker();
    const second = await createWorker();
    first.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const ownerBefore = readOwner();
    second.send({ type: "run", operation: "index" });
    const busy = await second.waitFor((message) => message.type === "result");

    expect(busy.code).toBe("INDEX_BUSY");
    expect(embeddingServer.requestCount).toBe(1);
    expect(readOwner()).toBe(ownerBefore);

    embeddingServer.release();
    const success = await first.waitFor((message) => message.type === "result");
    expect(success.ok).toBe(true);
    await first.waitForExit();
    await second.waitForExit();
    expect(embeddingServer.requestCount).toBe(1);
    expect(new Set(embeddingServer.inputs).size).toBe(embeddingServer.inputs.length);
    expect(embeddingServer.maxActive).toBe(1);
    assertIndexIntegrity();
  });

  it("keeps the active lease when the same Indexer receives an overlapping mutation", async () => {
    const indexer = createLocalIndexer();
    embeddingServer.block();
    const firstIndex = indexer.index();
    await embeddingServer.waitForRequestCount(1);
    const ownerBefore = readOwner();

    await expect(indexer.index()).rejects.toMatchObject({ code: "INDEX_BUSY" });
    expect(readOwner()).toBe(ownerBefore);
    expect(embeddingServer.requestCount).toBe(1);

    embeddingServer.release();
    await expect(firstIndex).resolves.toMatchObject({ indexedChunks: expect.any(Number) });
    await embeddingServer.waitForIdle();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    assertIndexIntegrity();
  });

  it("keeps a cold status read outside a live writer lease", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const lease = acquireIndexLock(indexPath, "index");
    const ownerBefore = readOwner();

    try {
      const status = await createLocalIndexer().getStatus();

      expect(status.indexed).toBe(true);
      expect(status.vectorCount).toBeGreaterThan(0);
      expect(readOwner()).toBe(ownerBefore);
      expect(embeddingServer.requestCount).toBe(0);
      expect(fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."))).toEqual([]);
    } finally {
      releaseIndexLock(lease);
    }
  });

  it("coordinates a cold reader and writer on the same Indexer", async () => {
    const indexer = createLocalIndexer();
    const [status, stats] = await Promise.all([
      indexer.getStatus(),
      indexer.index(),
    ]);

    expect(status.provider).toBe("custom");
    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    assertIndexIntegrity();
  });

  it("waits for writer-first initialization on the same Indexer", async () => {
    const indexer = createLocalIndexer();
    const indexing = indexer.index();
    const status = indexer.getStatus();
    const [stats, statusResult] = await Promise.all([indexing, status]);

    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(statusResult.compatibility).not.toBeNull();
    expect(embeddingServer.requestCount).toBe(1);
    assertIndexIntegrity();
  });

  it("defers auto-GC from a cold reader to the next writer", async () => {
    const indexer = createLocalIndexer(true);
    const indexPath = path.join(projectRoot, ".opencode", "index");

    await indexer.getStatus();
    const databaseBeforeWriter = new Database(path.join(indexPath, "codebase.db"));
    expect(databaseBeforeWriter.getMetadata("lastGcTimestamp")).toBeNull();
    databaseBeforeWriter.close();
    expect(embeddingServer.requestCount).toBe(0);

    await indexer.index();
    const databaseAfterWriter = new Database(path.join(indexPath, "codebase.db"));
    expect(databaseAfterWriter.getMetadata("lastGcTimestamp")).not.toBeNull();
    databaseAfterWriter.close();
    assertIndexIntegrity();
  });

  it("leaves crashed-writer recovery to the next writer", async () => {
    await seedIndex();
    embeddingServer.reset();
    fs.writeFileSync(sourcePath, "export function recovered() { return 'after-crash'; }\n");
    embeddingServer.block();
    const crashed = await createWorker();
    crashed.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    await crashed.kill();
    embeddingServer.release();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();

    const indexPath = path.join(projectRoot, ".opencode", "index");
    const ownerBeforeRead = readOwner();
    await createLocalIndexer().getStatus();

    expect(readOwner()).toBe(ownerBeforeRead);
    expect(embeddingServer.requestCount).toBe(0);
    expect(fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."))).toEqual([]);

    await createLocalIndexer().index();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();

    const recoveredStatus = await createLocalIndexer().getStatus();
    expect(recoveredStatus.indexed).toBe(true);
    expect(embeddingServer.requestCount).toBe(0);
    assertIndexIntegrity();
  });

  it("allows only one of two real MCP stdio servers to index", async () => {
    const configPath = path.join(tempDir, "mcp-config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      embeddingProvider: "custom",
      scope: "project",
      customProvider: {
        baseUrl: embeddingServer.baseUrl,
        model: "multiprocess-test",
        dimensions: 8,
        timeoutMs: 5000,
        maxBatchSize: 64,
        concurrency: 1,
        requestIntervalMs: 0,
      },
      include: ["**/*.ts"],
      exclude: ["**/.opencode/**", "**/.git/**", "**/node_modules/**"],
      indexing: {
        autoIndex: false,
        watchFiles: false,
        autoGc: false,
        retries: 0,
        retryDelayMs: 1,
        gitBlame: { enabled: false },
      },
      debug: { enabled: false },
    }));

    const first = await createMcpClient(configPath);
    const second = await createMcpClient(configPath);
    expect(first.transport.pid).not.toBeNull();
    expect(second.transport.pid).not.toBeNull();
    expect(first.transport.pid).not.toBe(second.transport.pid);

    embeddingServer.block();
    const firstResultPromise = first.client.callTool({ name: "index_codebase", arguments: {} });
    await embeddingServer.waitForRequestCount(1);
    const ownerBefore = readOwner();
    const busyResult = await second.client.callTool({ name: "index_codebase", arguments: {} });

    expect(busyResult.isError).toBe(true);
    expect((busyResult.content as Array<{ text?: string }>).map(({ text }) => text ?? "").join("\n")).toContain("INDEX_BUSY");
    expect(readOwner()).toBe(ownerBefore);
    expect(embeddingServer.requestCount).toBe(1);

    embeddingServer.release();
    const firstResult = await firstResultPromise;
    expect(firstResult.isError).not.toBe(true);
    await embeddingServer.waitForIdle();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);

    await Promise.all([first.client.close(), second.client.close()]);
    mcpClients = [];
    assertIndexIntegrity();
  });

  it.each([
    ["force", "index"],
    ["index", "force"],
  ] as const)("keeps %s against %s under one lease", async (winningOperation, losingOperation) => {
    await seedIndex();
    embeddingServer.reset();
    fs.writeFileSync(sourcePath, "export function alpha() { return 'updated'; }\nexport function gamma() { return alpha(); }\n");
    embeddingServer.block();

    const winner = await createWorker();
    const loser = await createWorker();
    winner.send({ type: "run", operation: winningOperation });
    const firstEvent = await Promise.race([
      embeddingServer.waitForRequestCount(1).then(() => ({ type: "embedding" as const })),
      winner.waitFor((message) => message.type === "result").then((message) => ({ type: "result" as const, message })),
    ]);
    if (firstEvent.type === "result") {
      throw new Error(`Winner exited before embedding: ${JSON.stringify(firstEvent.message)}`);
    }
    const ownerBefore = readOwner();
    loser.send({ type: "run", operation: losingOperation });
    const busy = await loser.waitFor((message) => message.type === "result");

    expect(busy.code).toBe("INDEX_BUSY");
    expect(embeddingServer.requestCount).toBe(1);
    expect(readOwner()).toBe(ownerBefore);

    embeddingServer.release();
    expect((await winner.waitFor((message) => message.type === "result")).ok).toBe(true);
    await winner.waitForExit();
    await loser.waitForExit();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    expect(new Set(embeddingServer.inputs).size).toBe(embeddingServer.inputs.length);
    assertIndexIntegrity();
  });

  it("recovers a crashed owner safely with two concurrent reclaimers", async () => {
    await seedIndex();
    embeddingServer.reset();
    fs.writeFileSync(sourcePath, "export function recovered() { return 'after-crash'; }\n");
    embeddingServer.block();
    const crashed = await createWorker();
    crashed.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const crashedOwner = JSON.parse(readOwner()) as { pid: number; token: string };
    await crashed.kill();
    embeddingServer.release();
    await embeddingServer.waitForIdle();

    const indexPath = path.join(projectRoot, ".opencode", "index");
    for (const fileName of ["vectors", "vectors.meta.json"]) {
      const targetPath = path.join(indexPath, fileName);
      fs.renameSync(targetPath, `${targetPath}.bak.${crashedOwner.pid}.${crashedOwner.token}`);
    }
    fs.writeFileSync(
      path.join(indexPath, `file-hashes.json.tmp.${crashedOwner.pid}.${crashedOwner.token}.1`),
      "interrupted",
    );

    embeddingServer.reset();
    embeddingServer.block();

    const first = await createWorker();
    const second = await createWorker();
    first.send({ type: "run", operation: "index" });
    second.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const newOwner = JSON.parse(readOwner()) as { token: string };
    expect(newOwner.token).not.toBe(crashedOwner.token);

    const firstResultPromise = first.waitFor((message) => message.type === "result");
    const secondResultPromise = second.waitFor((message) => message.type === "result");
    const busy = await Promise.race([firstResultPromise, secondResultPromise]);
    expect(busy.code).toBe("INDEX_BUSY");
    expect(embeddingServer.requestCount).toBe(1);

    embeddingServer.release();
    const results = await Promise.all([firstResultPromise, secondResultPromise]);
    expect(results.filter((result) => result.ok).length).toBe(1);
    expect(results.filter((result) => result.code === "INDEX_BUSY").length).toBe(1);
    await first.waitForExit();
    await second.waitForExit();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    expect(new Set(embeddingServer.inputs).size).toBe(embeddingServer.inputs.length);
    assertIndexIntegrity();
  });

  it("recovers every pending owner after the recovery process also crashes", async () => {
    await seedIndex();
    embeddingServer.reset();
    fs.writeFileSync(sourcePath, "export function recoveredTwice() { return 'after-two-crashes'; }\n");
    embeddingServer.block();

    const firstCrashed = await createWorker();
    firstCrashed.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const firstOwner = JSON.parse(readOwner()) as { token: string };
    await firstCrashed.kill();
    embeddingServer.release();
    await embeddingServer.waitForIdle();

    embeddingServer.reset();
    embeddingServer.block();
    const crashedRecovery = await createWorker();
    crashedRecovery.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const secondOwner = JSON.parse(readOwner()) as { token: string };
    expect(secondOwner.token).not.toBe(firstOwner.token);
    await crashedRecovery.kill();
    embeddingServer.release();
    await embeddingServer.waitForIdle();

    embeddingServer.reset();
    embeddingServer.block();
    const finalRecovery = await createWorker();
    finalRecovery.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);

    const indexPath = path.join(projectRoot, ".opencode", "index");
    const pendingMarkers = fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."));
    expect(pendingMarkers).toHaveLength(2);

    embeddingServer.release();
    expect((await finalRecovery.waitFor((message) => message.type === "result")).ok).toBe(true);
    await finalRecovery.waitForExit();
    await embeddingServer.waitForIdle();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    expect(fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."))).toEqual([]);
    assertIndexIntegrity();
  });

  it("coalesces two watcher processes without duplicate embeddings", async () => {
    const first = await createWorker();
    const second = await createWorker();
    first.send({ type: "run", operation: "watch" });
    second.send({ type: "run", operation: "watch" });
    await Promise.all([
      first.waitFor((message) => message.type === "watcher-ready"),
      second.waitFor((message) => message.type === "watcher-ready"),
    ]);

    embeddingServer.block();
    fs.writeFileSync(sourcePath, "export function watched() { return 'changed'; }\n");
    await embeddingServer.waitForRequestCount(1);
    const ownerBefore = readOwner();
    const busy = await Promise.race([
      first.waitFor((message) => message.type === "watch-result" && message.code === "INDEX_BUSY"),
      second.waitFor((message) => message.type === "watch-result" && message.code === "INDEX_BUSY"),
    ]);
    expect(busy.code).toBe("INDEX_BUSY");
    expect(embeddingServer.requestCount).toBe(1);
    expect(readOwner()).toBe(ownerBefore);

    embeddingServer.release();
    await Promise.race([
      first.waitFor((message) => message.type === "watch-result" && message.ok === true),
      second.waitFor((message) => message.type === "watch-result" && message.ok === true),
    ]);
    await Promise.all([
      first.waitFor((message) => message.type === "watch-result" && message.ok === true),
      second.waitFor((message) => message.type === "watch-result" && message.ok === true),
    ]);

    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    expect(new Set(embeddingServer.inputs).size).toBe(embeddingServer.inputs.length);
    await Promise.all([first.stop(), second.stop()]);
    assertIndexIntegrity();
  });
});
