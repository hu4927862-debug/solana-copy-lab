import Database from "better-sqlite3";
import { setTimeout as delay } from "node:timers/promises";

export const RPC_BUDGET_POLICY = "QUICKNODE_CONSERVATIVE_V1";
/** Non-resetting launch allowance, not an estimate of the provider's remaining quota.
 * A durable in-flight lease fails closed after a process crash. Never reclaim it
 * automatically: an old HTTP request might still be alive. No endpoint secrets stored.
 */
export class RpcRequestBudget {
  private readonly db: Database.Database;
  private quietUntil = performance.now() + 100;
  constructor(path: string, limit = 4_000, private readonly stopAt = limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4_000)
      throw new Error("RPC_INVALID_BUDGET");
    if (!Number.isSafeInteger(stopAt) || stopAt < 1 || stopAt > limit) throw new Error("RPC_INVALID_RESERVE");
    this.db = new Database(path);
    this.db.pragma("busy_timeout = 1000");
    this.db.pragma("synchronous = FULL");
    this.db.exec("CREATE TABLE IF NOT EXISTS quota (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL, ceiling INTEGER NOT NULL, used INTEGER NOT NULL, busy INTEGER NOT NULL, next_ms INTEGER NOT NULL, tripped INTEGER NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO quota VALUES (1,?,?,0,0,0,0)").run(RPC_BUDGET_POLICY, limit);
    const row = this.db.prepare("SELECT policy, ceiling FROM quota").get() as { policy: string; ceiling: number };
    if (row.policy !== RPC_BUDGET_POLICY || row.ceiling !== limit) {
      this.db.close(); throw new Error("RPC_BUDGET_IDENTITY_MISMATCH");
    }
  }
  async run<T>(request: () => Promise<T>, signal: AbortSignal = AbortSignal.timeout(3_000)): Promise<T> {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM quota WHERE id=1").get() as { used: number; ceiling: number; busy: number; next_ms: number; tripped: number };
      if (row.tripped || row.used >= Math.min(row.ceiling, this.stopAt)) throw new Error("RPC_LOCAL_BUDGET_EXHAUSTED");
      if (row.busy || Date.now() < row.next_ms || performance.now() < this.quietUntil) return false;
      this.db.prepare("UPDATE quota SET used=used+1,busy=1 WHERE id=1").run();
      return true;
    });
    for (;;) {
      signal.throwIfAborted();
      if (claim.immediate()) break;
      await delay(25, undefined, { signal });
    }
    try {
      signal.throwIfAborted();
      return await request();
    } finally {
      this.quietUntil = performance.now() + 100;
      this.db.prepare("UPDATE quota SET busy=0,next_ms=? WHERE id=1").run(Date.now() + 100);
    }
  }
  status(): { used: number; ceiling: number; busy: number; tripped: number } {
    return this.db.prepare("SELECT used,ceiling,busy,tripped FROM quota WHERE id=1").get() as { used: number; ceiling: number; busy: number; tripped: number };
  }
  trip(): void { this.db.prepare("UPDATE quota SET tripped=1 WHERE id=1").run(); }
  close(): void { this.db.close(); }
}

const configured = new Map<string, RpcRequestBudget>();
export function configuredRpcBudget(): RpcRequestBudget | undefined {
  const policy = process.env.V6_RPC_BUDGET_POLICY;
  if (policy === undefined) return undefined;
  const path = process.env.V6_RPC_BUDGET_PATH;
  if (policy !== RPC_BUDGET_POLICY || !path?.startsWith("/")) throw new Error("RPC_BUDGET_CONFIGURATION_INVALID");
  let budget = configured.get(path);
  if (!budget) { budget = new RpcRequestBudget(path, 4000, process.env.V6_RPC_BUDGET_PHASE === "runtime" ? 3900 : 4000); configured.set(path, budget); }
  return budget;
}
