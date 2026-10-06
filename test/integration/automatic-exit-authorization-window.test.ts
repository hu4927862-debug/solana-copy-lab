import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { testStore } from "../helpers/database.js";
import { envelope } from "../helpers/envelope.js";
import { MAINNET_FIXTURES, LEADER_A, FOLLOWER, TOKEN_MINT } from "../fixtures/mainnet-fixtures.js";
import { parseRiskPolicy } from "../../src/risk/risk-policy.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { ExecutionCoordinator } from "../../src/execution/execution-coordinator.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import { AutomaticExitRecovery } from "../../src/recovery/automatic-exit-recovery.js";

// Offline: fresh mkdtemp SQLite, real ledger/coordinator/risk/sender, mock quote boundary.
// Both risk's Clock and recovery's now share one clock, including response-time movement.
describe("original source authorization window under frozen ordinary risk", () => {
  it.each([
    { start: 59_000, returned: 60_000, state: "COMPLETED", reason: "EXIT_FILLED", attempts: 1 },
    { start: 59_000, returned: 60_001, state: "ATTENTION", reason: "SOURCE_AUTHORIZATION_EXPIRED", attempts: 1 },
    { start: 60_001, returned: 60_001, state: "ATTENTION", reason: "SOURCE_AUTHORIZATION_EXPIRED", attempts: 0 },
  ])("source age $start → $returned ms gives $state without renewed authority", async (c) => {
    const policy = parseRiskPolicy(JSON.parse(readFileSync(new URL("../../config/risk-policy.json", import.meta.url), "utf8")));
    expect(policy.maxIntentAgeMs).toBe(60_000);
    expect(policy.maxQuoteAgeMs).toBe(5_000);
    let now = 1_730_000_000_500;
    const clock = { now: () => ({ wallMs: now, monotonicNs: BigInt(now) * 1_000_000n }) };
    const fixture = testStore("exit-auth-window-", policy);
    const store = new StateStore(fixture.database, clock, policy);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let recoveryPhase = false;
    let sourceMs = 0;
    const provider = new MockJupiterOrderProvider();
    const sender = new PaperTransactionSender({ getOrder: async request => {
      if (recoveryPhase) now = sourceMs + c.returned;
      return { ...(await provider.getOrder(request)), priceImpactPct: request.inputMint === TOKEN_MINT && !recoveryPhase ? "-3" : "0" };
    } });
    const recovery = new AutomaticExitRecovery(store, sender, () => now);
    try {
      recovery.enableFresh();
      await store.upsertWallet(LEADER_A, "LEADER", 1000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const coordinator = new ExecutionCoordinator(store, sender);
      for (const raw of [MAINNET_FIXTURES.jupiterBuy, MAINNET_FIXTURES.fullSell]) {
        const classified = new SwapClassifier().classify(new TransactionNormalizer(clock).normalize(envelope(raw)), LEADER_A);
        if (!classified.accepted) throw Error(classified.code);
        await store.saveLeaderTrade(classified.event);
        const intent = new CopyEngine().decide(classified.event, { followerWallet: FOLLOWER, copyRatioBps: 1000, mode: "PAPER" }, store.getFollowerPosition(FOLLOWER, LEADER_A, TOKEN_MINT, "SOL_NATIVE"));
        if (intent.side === "SELL") sourceMs = intent.authoritativeSourceTimestamp!.valueMs;
        await coordinator.execute(intent);
      }
      expect(recovery.statuses()).toMatchObject([{ state: "WAITING", attempts: 0 }]);
      const before = store.getFollowerPosition(FOLLOWER, LEADER_A, TOKEN_MINT, "SOL_NATIVE")!;
      expect(before.rawAmount).toBeGreaterThan(0n);
      const requests = provider.requests.length;
      recoveryPhase = true;
      now = sourceMs + c.start;
      await recovery.tick();
      expect(recovery.statuses()).toMatchObject([{ state: c.state, attempts: c.attempts }]);
      if (c.state === "ATTENTION") expect(recovery.statuses()[0]!.reason).toBe(c.reason);
      expect(provider.requests.length - requests).toBe(c.attempts);
      expect(store.getFollowerPosition(FOLLOWER, LEADER_A, TOKEN_MINT, "SOL_NATIVE")).toMatchObject({ rawAmount: c.state === "COMPLETED" ? 0n : before.rawAmount, reservedRawAmount: 0n });
      expect(recovery.pendingQuoteCount).toBe(0);
    } finally {
      await recovery.stop();
      fixture.database.close();
      vi.restoreAllMocks();
    }
  });
});
