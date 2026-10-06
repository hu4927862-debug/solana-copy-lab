import { it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RpcRequestBudget } from "../../src/network/rpc-request-budget.js";
import { SolanaKitRpcProvider } from "../../src/rpc/solana-kit-rpc-provider.js";
import { TestClock } from "../helpers/test-clock.js";

it("preserves a separate audit reserve without resetting the shared counter", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "rpc-reserve-budget-")), "budget.sqlite");
  const runtime = new RpcRequestBudget(path, 3, 2), audit = new RpcRequestBudget(path, 3);
  await runtime.run(async()=>1); await runtime.run(async()=>1);
  await expect(runtime.run(async()=>1)).rejects.toThrow("RPC_LOCAL_BUDGET_EXHAUSTED");
  expect(await audit.run(async()=>9)).toBe(9);
  await expect(audit.run(async()=>9)).rejects.toThrow("RPC_LOCAL_BUDGET_EXHAUSTED");
  runtime.close();audit.close();
});

it("paces independent connections and persists the non-resetting allowance across reopen", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "rpc-budget-")), "budget.sqlite");
  const a = new RpcRequestBudget(path, 3), b = new RpcRequestBudget(path, 3);
  const starts: number[] = [];
  const task = async () => { starts.push(performance.now()); return 7; };
  await Promise.all([a.run(task), b.run(task), a.run(task)]);
  expect(starts).toHaveLength(3);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(95);
  expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(95);
  a.close(); b.close();
  const reopened = new RpcRequestBudget(path, 3);
  await expect(reopened.run(task)).rejects.toThrow("RPC_LOCAL_BUDGET_EXHAUSTED");
  expect(starts).toHaveLength(3);
  reopened.close();
});

it("fails closed after a separate process dies with a durable in-flight request", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "rpc-crash-budget-")), "budget.sqlite");
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {RpcRequestBudget} from './src/network/rpc-request-budget.ts'; const b=new RpcRequestBudget(process.argv[1],3); await b.run(async()=>process.exit(0));`, path], { timeout: 5000 });
  expect(child.status).toBe(0);
  const b = new RpcRequestBudget(path, 3);
  expect(b.status()).toMatchObject({busy:1,used:1});
  await expect(b.run(async()=>99,AbortSignal.timeout(40))).rejects.toThrow();
  expect(b.status()).toMatchObject({busy:1,used:1}); b.close();
});

it("counts failures, rejects an aborted waiter without HTTP, and persists provider limit trips", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "rpc-budget-")), "budget.sqlite");
  const a = new RpcRequestBudget(path, 3);
  await expect(a.run(async () => { throw Error("transport failed"); })).rejects.toThrow("transport failed");
  expect(a.status().used).toBe(1);
  const abort = new AbortController(); abort.abort();
  let sent = 0;
  await expect(a.run(async () => { sent++; }, abort.signal)).rejects.toThrow();
  expect(sent).toBe(0);
  a.trip(); a.close();
  const b = new RpcRequestBudget(path, 3);
  await expect(b.run(async () => { sent++; })).rejects.toThrow("RPC_LOCAL_BUDGET_EXHAUSTED");
  expect(sent).toBe(0); b.close();
});

it("does not release an unfinished request when a queued caller times out", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "rpc-budget-")), "budget.sqlite");
  const a = new RpcRequestBudget(path, 3), b = new RpcRequestBudget(path, 3);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const held = a.run(() => new Promise<void>(r => { release = r; started(); }));
  await ready;
  await expect(b.run(async () => 1, AbortSignal.timeout(40))).rejects.toThrow();
  expect(b.status()).toMatchObject({ used: 1, busy: 1 });
  release(); await held;
  expect(await b.run(async () => 9)).toBe(9);
  a.close(); b.close();
});

it("trips the shared allowance on real Kit HTTP 429 and suppresses hydration retries", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "rpc-provider-budget-")), "budget.sqlite");
  vi.stubEnv("V6_RPC_BUDGET_POLICY", "QUICKNODE_CONSERVATIVE_V1"); vi.stubEnv("V6_RPC_BUDGET_PATH", path);
  const http = vi.fn(async () => new Response("limited", {status:429})); vi.stubGlobal("fetch",http);
  try {
    const p = new SolanaKitRpcProvider("https://rpc.invalid",new TestClock());
    await expect(p.getCurrentSlot()).rejects.toThrow();
    await expect(p.getTransaction("retry")).rejects.toThrow("RPC_LOCAL_BUDGET_EXHAUSTED");
    expect(http).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

it("routes actual Kit slot, parallel multi-address pages, and raw hydration through one HTTP allowance", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "rpc-provider-budget-")), "budget.sqlite");
  vi.stubEnv("V6_RPC_BUDGET_POLICY", "QUICKNODE_CONSERVATIVE_V1");
  vi.stubEnv("V6_RPC_BUDGET_PATH", path);
  const calls: { time: number; method: string }[] = [];
  const http = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ time: performance.now(), method: body.method });
    const result = body.method === "getSlot" ? 100 : body.method === "getTransaction" ? null :
      { data: [], paginationToken: body.params[1].paginationToken ? null : "page2" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", http);
  try {
    const a = new SolanaKitRpcProvider("https://rpc.invalid", new TestClock());
    const b = new SolanaKitRpcProvider("https://rpc.invalid", new TestClock());
    await Promise.all([a.getCurrentSlot(), b.getTransaction("test"), a.getTransactionsForAddress("11111111111111111111111111111111", {afterSlot: 0n}), b.getTransactionsForAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", {afterSlot: 0n})]);
    expect(calls).toHaveLength(6);
    expect(calls.filter(x => x.method === "getTransactionsForAddress")).toHaveLength(4);
    for (let i=1;i<calls.length;i++) expect(calls[i]!.time-calls[i-1]!.time).toBeGreaterThanOrEqual(95);
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
