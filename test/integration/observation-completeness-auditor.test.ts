import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  RpcProvider,
  StreamTransactionEnvelope,
} from "../../src/domain/ports.js";
import {
  ObservationCompletenessAuditor,
  reconcileObservationSignatures,
} from "../../src/validation/observation-completeness-auditor.js";
import { SqliteDatabase } from "../../src/persistence/database.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { TEST_RISK_POLICY, testStore } from "../helpers/database.js";
import { TestClock } from "../helpers/test-clock.js";

const LEADER = "D5bMZEkbmHB63YUMbncs7gDMBqqUf6giAjecqEbccJRJ";

const WINDOW = {
  startSlot: 100n,
  endSlot: 200n,
  startTimestampMs: 1_000,
  endTimestampMs: 2_000,
  targetWallets: [LEADER],
  provider: "primary",
} as const;

function transaction(
  signature: string,
  slot: bigint,
  sourceTimestampMs: number | null = 1_500,
  payload: unknown = { accountKeys: [{ address: LEADER }] },
): StreamTransactionEnvelope {
  return {
    signature,
    slot,
    ...(sourceTimestampMs === null ? {} : { sourceTimestampMs }),
    sourceTimestampPrecision: "SLOT_ONLY",
    sourceTimestampProvenance: "UNKNOWN",
    streamReceivedTimestampMs: 1_500,
    streamReceivedMonotonicNs: 1n,
    payload,
  };
}

function rpcWith(
  transactions: readonly StreamTransactionEnvelope[] | Error,
): RpcProvider {
  return {
    getTransaction: async () => undefined,
    getTransactionsForAddress: async () => {
      if (transactions instanceof Error) throw transactions;
      return transactions;
    },
    resolveAddressLookupTable: async () => [],
  };
}

function recordGapState(
  sqlite: ReturnType<typeof testStore>["database"]["sqlite"],
  events: readonly (
    "DISCONNECTED" | "REPLAY_STARTED" | "REPLAY_COMPLETED" | "REPLAY_FAILED"
  )[] = ["REPLAY_STARTED", "REPLAY_COMPLETED"],
): void {
  const insert = sqlite.prepare(
    `INSERT INTO stream_health_events
     (provider, type, duration_ms, details_json, wall_timestamp_ms, monotonic_timestamp_ns)
     VALUES ('primary', ?, NULL, '{}', ?, '1')`,
  );
  events.forEach((event, index) => insert.run(event, 1_100 + index));
}

function recordReceipt(
  sqlite: ReturnType<typeof testStore>["database"]["sqlite"],
  signature: string,
  slot: bigint,
  replay: boolean,
  provider: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO provider_receipts
       (signature, provider, slot, received_timestamp_ms, received_monotonic_ns, is_replay, created_at_ms)
       VALUES (?, ?, ?, 1500, '1', ?, 1500)`,
    )
    .run(signature, provider, slot.toString(), replay ? 1 : 0);
}

async function audit(
  chain: readonly StreamTransactionEnvelope[] | Error,
  receipts: readonly {
    signature: string;
    slot?: bigint;
    replay?: boolean;
    provider?: string;
  }[] = [],
  gapEvents?: readonly (
    "DISCONNECTED" | "REPLAY_STARTED" | "REPLAY_COMPLETED" | "REPLAY_FAILED"
  )[],
) {
  const { database, store } = testStore("observation-audit-");
  try {
    recordGapState(database.sqlite, gapEvents);
    receipts.forEach((receipt) =>
      recordReceipt(
        database.sqlite,
        receipt.signature,
        receipt.slot ?? 150n,
        receipt.replay ?? false,
        receipt.provider ?? "primary",
      ),
    );
    return await new ObservationCompletenessAuditor(
      rpcWith(chain),
      store,
    ).audit(WINDOW);
  } finally {
    database.close();
  }
}

describe("ObservationCompletenessAuditor", () => {
  it("passes an empty chain window as no target activity", async () => {
    const result = await audit([]);
    expect(result.status).toBe("OBSERVATION_COMPLETENESS_PASS");
    expect(result.activityStatus).toBe("NO_TARGET_ACTIVITY");
    expect(result.missingSignatures).toEqual([]);
  });

  it("runs against a SQLite connection that rejects writes", async () => {
    const initial = testStore("observation-readonly-");
    recordGapState(initial.database.sqlite);
    initial.database.close();
    const database = new SqliteDatabase({
      path: initial.path,
      migrationsDirectory: resolve("migrations"),
      readOnly: true,
    });
    try {
      const result = await new ObservationCompletenessAuditor(
        rpcWith([]),
        new StateStore(database, new TestClock(), TEST_RISK_POLICY),
      ).audit(WINDOW);
      expect(result.status).toBe("OBSERVATION_COMPLETENESS_PASS");
      expect(() =>
        database.sqlite.prepare("DELETE FROM stream_health_events").run(),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("passes when live receipts account for every chain signature", async () => {
    const result = await audit(
      [transaction("A", 101n), transaction("B", 150n), transaction("C", 200n)],
      [{ signature: "A" }, { signature: "B" }, { signature: "C" }],
    );
    expect(result.status).toBe("OBSERVATION_COMPLETENESS_PASS");
    expect(result.accountedSignatures).toEqual(["A", "B", "C"]);
  });

  it("passes when replay receipts close the live observation gap", async () => {
    const result = await audit(
      [transaction("A", 101n), transaction("B", 150n), transaction("C", 200n)],
      [
        { signature: "A" },
        { signature: "B" },
        { signature: "C", replay: true },
      ],
    );
    expect(result.status).toBe("OBSERVATION_COMPLETENESS_PASS");
    expect(result.replayedSignatures).toEqual(["C"]);
  });

  it("reports a missing chain signature as incomplete", async () => {
    const result = await audit(
      [transaction("A", 101n), transaction("B", 150n), transaction("C", 200n)],
      [{ signature: "A" }, { signature: "B" }],
    );
    expect(result.status).toBe("OBSERVATION_INCOMPLETE");
    expect(result.missingSignatures).toEqual(["C"]);
  });

  it("deduplicates live and replay signatures while reporting the duplicate", () => {
    const result = reconcileObservationSignatures(["C"], ["C"], ["C"]);
    expect(result.accountedSignatures).toEqual(["C"]);
    expect(result.duplicateSignatures).toEqual(["C"]);
  });

  it("does not let a passive secondary receipt cover a primary miss", async () => {
    const result = await audit(
      [transaction("PRIMARY", 150n), transaction("SECONDARY_ONLY", 151n)],
      [
        { signature: "PRIMARY" },
        { signature: "SECONDARY_ONLY", provider: "secondary" },
      ],
    );
    expect(result.status).toBe("OBSERVATION_INCOMPLETE");
    expect(result.accountedSignatures).toEqual(["PRIMARY"]);
    expect(result.missingSignatures).toEqual(["SECONDARY_ONLY"]);
  });

  it("fails closed when the independent RPC audit fails", async () => {
    const result = await audit(new Error("RPC_UNAVAILABLE"));
    expect(result.status).toBe("COMPLETENESS_UNVERIFIED");
    expect(result.auditError).toBe("INDEPENDENT_RPC_AUDIT_FAILED");
  });

  it("fails closed when the provider result limit is reached", async () => {
    const result = await audit(
      Array.from({ length: 100 }, (_, index) =>
        transaction(`SIGNATURE_${index}`, 150n),
      ),
    );
    expect(result.status).toBe("COMPLETENESS_UNVERIFIED");
    expect(result.auditError).toBe("INDEPENDENT_RPC_RESULT_LIMIT_REACHED");
  });

  it("fails closed when a chain signature has no timestamp", async () => {
    const result = await audit([transaction("NO_TIMESTAMP", 150n, null)]);
    expect(result.status).toBe("COMPLETENESS_UNVERIFIED");
    expect(result.auditError).toBe("INDEPENDENT_RPC_TIMESTAMP_UNAVAILABLE");
  });

  it("cannot pass with an unresolved websocket gap", async () => {
    const result = await audit([], [], ["REPLAY_STARTED"]);
    expect(result.status).toBe("COMPLETENESS_UNVERIFIED");
    expect(result.gapState.unresolvedGapCount).toBe(1);
  });

  it("cannot pass when a disconnect has no reconnect recovery", async () => {
    const result = await audit(
      [],
      [],
      ["REPLAY_STARTED", "REPLAY_COMPLETED", "DISCONNECTED"],
    );
    expect(result.status).toBe("COMPLETENESS_UNVERIFIED");
    expect(result.gapState.unresolvedGapCount).toBe(1);
  });

  it("excludes signatures outside the run slot window", async () => {
    const result = await audit(
      [
        transaction("BEFORE", 100n),
        transaction("INSIDE", 150n),
        transaction("AFTER", 201n),
      ],
      [
        { signature: "BEFORE", slot: 100n },
        { signature: "INSIDE", slot: 150n },
        { signature: "AFTER", slot: 201n },
      ],
    );
    expect(result.chainSignatures).toEqual(["INSIDE"]);
    expect(result.accountedSignatures).toEqual(["INSIDE"]);
    expect(result.status).toBe("OBSERVATION_COMPLETENESS_PASS");
  });

  it("excludes a signature confirmed after the run timestamp boundary", async () => {
    const result = await audit([transaction("AFTER_SHUTDOWN", 150n, 2_001)]);
    expect(result.chainSignatures).toEqual([]);
    expect(result.status).toBe("OBSERVATION_COMPLETENESS_PASS");
    expect(result.activityStatus).toBe("NO_TARGET_ACTIVITY");
  });

  it("excludes token-owner-only transactions outside runtime mentions semantics", async () => {
    const tokenOwnerOnly = transaction("TOKEN_OWNER_ONLY", 150n, 1_500, {
      accountKeys: [
        { address: "DQifC9AbRL4GJFFyKGhgzLV9XWjCpGaBNC5LFv5uAaqb" },
      ],
      preTokenBalances: [{ owner: LEADER }],
      postTokenBalances: [{ owner: LEADER }],
    });
    const result = await audit([tokenOwnerOnly]);
    expect(result.chainSignatures).toEqual([]);
    expect(result.status).toBe("OBSERVATION_COMPLETENESS_PASS");
    expect(result.activityStatus).toBe("NO_TARGET_ACTIVITY");
  });

  it("fails closed when the RPC transaction account-key boundary is malformed", async () => {
    const malformed = transaction("MALFORMED", 150n, 1_500, {
      preTokenBalances: [{ owner: LEADER }],
      postTokenBalances: [{ owner: LEADER }],
    });
    const result = await audit([malformed]);
    expect(result.status).toBe("COMPLETENESS_UNVERIFIED");
    expect(result.auditError).toBe(
      "INDEPENDENT_RPC_TRANSACTION_SCHEMA_INVALID",
    );
  });

  it("fails closed when an RPC transaction account-key entry is malformed", async () => {
    const malformed = transaction("MALFORMED_ENTRY", 150n, 1_500, {
      accountKeys: [{ address: LEADER }, null],
    });
    const result = await audit([malformed]);
    expect(result.status).toBe("COMPLETENESS_UNVERIFIED");
    expect(result.auditError).toBe(
      "INDEPENDENT_RPC_TRANSACTION_SCHEMA_INVALID",
    );
  });

  it("fails closed when the RPC transaction account-key list is empty", async () => {
    const malformed = transaction("EMPTY_KEYS", 150n, 1_500, {
      accountKeys: [],
    });
    const result = await audit([malformed]);
    expect(result.status).toBe("COMPLETENESS_UNVERIFIED");
    expect(result.auditError).toBe(
      "INDEPENDENT_RPC_TRANSACTION_SCHEMA_INVALID",
    );
  });

  it("fails closed when the RPC mapper stringifies a malformed account key", async () => {
    const malformed = transaction("STRINGIFIED_NULL_KEY", 150n, 1_500, {
      accountKeys: [{ address: LEADER }, { address: "null" }],
    });
    const result = await audit([malformed]);
    expect(result.status).toBe("COMPLETENESS_UNVERIFIED");
    expect(result.auditError).toBe(
      "INDEPENDENT_RPC_TRANSACTION_SCHEMA_INVALID",
    );
  });
});
