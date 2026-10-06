import { describe, expect, it, vi } from "vitest";
import type {
  JupiterOrder,
  JupiterOrderProvider,
} from "../../src/execution/jupiter-order-adapter.js";
import { JupiterRequestError } from "../../src/execution/jupiter-order-adapter.js";
import type { ExecutionIntent } from "../../src/domain/execution.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import {
  DelayedQuoteSidecar,
  type DelayController,
} from "../../src/research/delayed-quote-sidecar.js";
import {
  ExecutionRealismEvidenceStore,
  type FirstQuoteResearchParent,
} from "../../src/persistence/execution-realism-evidence-store.js";
import { testStore } from "../helpers/database.js";

const parent: FirstQuoteResearchParent = {
  executionKey: "execution-parent-1",
  validationEventId: "validation-parent-1",
  referenceTimestampMs: 1_000,
  inputMint: "input-mint",
  outputMint: "output-mint",
  inputAmountRaw: 500n,
  firstQuoteOutputAmountRaw: 1_000n,
};

function order(output = 900n): JupiterOrder {
  return {
    requestId: "delayed-request",
    inputMint: parent.inputMint,
    outputMint: parent.outputMint,
    inputRaw: parent.inputAmountRaw,
    expectedOutputRaw: output,
    router: "iris",
    mode: "ExactIn",
    feeBps: 0,
    feeMint: parent.outputMint,
    priceImpactPct: "0.25",
    route: [{ swapInfo: { label: "route" } }],
    requestTimestampMs: 4_010,
    responseTimestampMs: 4_110,
    requestMonotonicNs: 4_010_000_000n,
    responseMonotonicNs: 4_110_000_000n,
    httpStatus: 200,
    schemaValid: true,
    hasAssembledTransaction: false,
  };
}

const immediateDelay: DelayController = {
  nowMs: () => 4_010,
  waitUntil: vi.fn(async () => undefined),
};

describe("execution-realism delayed quote evidence", () => {
  it("leaves the first quote-as-fill result unchanged after a later quote", async () => {
    const firstProvider: JupiterOrderProvider = {
      getOrder: async () => order(1_000n),
    };
    const intent: ExecutionIntent = {
      executionKey: parent.executionKey,
      leaderTradeId: "leader-trade",
      leaderWallet: "leader-wallet",
      followerWallet: "follower-wallet",
      mode: "SHADOW",
      side: "BUY",
      tokenMint: parent.outputMint,
      quoteMint: parent.inputMint,
      theoreticalTokenRaw: 1n,
      theoreticalQuoteRaw: parent.inputAmountRaw,
      copyRatioBps: 1_000,
      createdAtMs: 1,
      createdMonotonicNs: 1n,
    };
    const result = await new PaperTransactionSender(firstProvider).send(intent);
    expect(result).toMatchObject({
      state: "PAPER_EXECUTED",
      executedTokenRaw: 1_000n,
      executedQuoteRaw: 500n,
      paperQuoteEvidence: { outputAmountRaw: 1_000n },
    });

    const { database } = testStore("execution-realism-paper-isolation-");
    try {
      const sidecar = new DelayedQuoteSidecar(
        { getOrder: async () => order(700n) },
        new ExecutionRealismEvidenceStore(database),
        {
          policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1",
          referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
          delayOffsetsMs: [3_000],
          requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
        },
        immediateDelay,
      );
      sidecar.enqueue(parent);
      await sidecar.drain();

      expect(result).toMatchObject({
        state: "PAPER_EXECUTED",
        executedTokenRaw: 1_000n,
        executedQuoteRaw: 500n,
        paperQuoteEvidence: { outputAmountRaw: 1_000n },
      });
    } finally {
      database.close();
    }
  });

  it("persists exact successful evidence and an exact output comparison", async () => {
    const { database } = testStore("execution-realism-success-");
    try {
      const store = new ExecutionRealismEvidenceStore(database);
      const provider: JupiterOrderProvider = {
        getOrder: vi.fn(async (request) => {
          expect(request).toEqual({
            inputMint: parent.inputMint,
            outputMint: parent.outputMint,
            amount: parent.inputAmountRaw,
          });
          return order();
        }),
      };
      const sidecar = new DelayedQuoteSidecar(
        provider,
        store,
        {
          policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1",
          referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
          delayOffsetsMs: [3_000],
          requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
        },
        immediateDelay,
      );

      sidecar.enqueue(parent);
      await sidecar.drain();

      expect(store.list(parent.executionKey)).toEqual([
        expect.objectContaining({
          parentExecutionKey: parent.executionKey,
          intendedDelayMs: 3_000,
          actualObservedDelayMs: 3_010,
          inputMint: parent.inputMint,
          outputMint: parent.outputMint,
          inputAmountRaw: "500",
          returnedInputAmountRaw: null,
          returnedInputAmountStatus: "UNAVAILABLE",
          returnedOutputAmountRaw: "900",
          jupiterRequestId: "delayed-request",
          swapMode: "ExactIn",
          httpStatus: 200,
          schemaValid: true,
          route: [{ swapInfo: { label: "route" } }],
          routeStatus: "AVAILABLE",
          outcome: "SUCCESS",
          failureCode: null,
        }),
      ]);
      expect(store.compare(parent, [3_000])).toEqual([
        {
          intendedDelayMs: 3_000,
          status: "AVAILABLE",
          firstQuoteOutputAmountRaw: "1000",
          delayedQuoteOutputAmountRaw: "900",
          relativeOutputDecay: { numeratorRaw: "100", denominatorRaw: "1000" },
          availabilityReason: null,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps an absent optional route and returned input explicitly unavailable", async () => {
    const { database } = testStore("execution-realism-unavailable-fields-");
    try {
      const store = new ExecutionRealismEvidenceStore(database);
      const sidecar = new DelayedQuoteSidecar(
        {
          getOrder: async () => {
            const { priceImpactPct: _omitted, ...withoutPriceImpact } = order();
            return { ...withoutPriceImpact, route: [] };
          },
        },
        store,
        {
          policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1",
          referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
          delayOffsetsMs: [3_000],
          requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
        },
        immediateDelay,
      );

      sidecar.enqueue(parent);
      await sidecar.drain();

      expect(store.list(parent.executionKey)).toEqual([
        expect.objectContaining({
          inputAmountRaw: "500",
          returnedInputAmountRaw: null,
          returnedInputAmountStatus: "UNAVAILABLE",
          route: null,
          routeStatus: "UNAVAILABLE",
          priceImpactPct: null,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps failures as NULL evidence and never converts them to zero", async () => {
    const { database } = testStore("execution-realism-failure-");
    try {
      const store = new ExecutionRealismEvidenceStore(database);
      const provider: JupiterOrderProvider = {
        getOrder: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
      };
      const sidecar = new DelayedQuoteSidecar(
        provider,
        store,
        {
          policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1",
          referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
          delayOffsetsMs: [3_000],
          requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
        },
        immediateDelay,
      );

      sidecar.enqueue(parent);
      await sidecar.drain();

      expect(store.list(parent.executionKey)).toEqual([
        expect.objectContaining({
          outcome: "FAILURE",
          failureCode: "UNEXPECTED_ERROR",
          returnedInputAmountRaw: null,
          returnedInputAmountStatus: "UNAVAILABLE",
          returnedOutputAmountRaw: null,
          jupiterRequestId: null,
          swapMode: null,
          httpStatus: null,
          schemaValid: false,
          route: null,
          routeStatus: "UNAVAILABLE",
          priceImpactPct: null,
        }),
      ]);
      expect(store.compare(parent, [3_000])).toEqual([
        {
          intendedDelayMs: 3_000,
          status: "UNAVAILABLE",
          firstQuoteOutputAmountRaw: "1000",
          delayedQuoteOutputAmountRaw: null,
          relativeOutputDecay: null,
          availabilityReason: "DELAYED_QUOTE_FAILED",
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("persists a timeout taxonomy with unavailable quote fields", async () => {
    const { database } = testStore("execution-realism-timeout-");
    try {
      const store = new ExecutionRealismEvidenceStore(database);
      const sidecar = new DelayedQuoteSidecar(
        {
          getOrder: async () => {
            throw new JupiterRequestError("request timed out", {
              requestTimestampMs: 4_020,
              responseTimestampMs: 7_020,
              requestMonotonicNs: 4_020_000_000n,
              responseMonotonicNs: 7_020_000_000n,
              schemaValid: false,
            });
          },
        },
        store,
        {
          policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1",
          referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
          delayOffsetsMs: [3_000],
          requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
        },
        immediateDelay,
      );

      sidecar.enqueue(parent);
      await sidecar.drain();

      expect(store.list(parent.executionKey)).toEqual([
        expect.objectContaining({
          failureCode: "TIMEOUT",
          actualRequestTimestampMs: 4_020,
          actualResponseTimestampMs: 7_020,
          httpStatus: null,
          returnedOutputAmountRaw: null,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("schedules both fixed offsets from the same first-response reference", async () => {
    const { database } = testStore("execution-realism-schedule-");
    let currentMs = parent.referenceTimestampMs;
    const delay: DelayController = {
      nowMs: () => currentMs,
      waitUntil: vi.fn(async (timestampMs) => {
        currentMs = timestampMs;
      }),
    };
    try {
      const store = new ExecutionRealismEvidenceStore(database);
      const sidecar = new DelayedQuoteSidecar(
        {
          getOrder: async () => ({
            ...order(),
            requestTimestampMs: currentMs,
            responseTimestampMs: currentMs + 100,
          }),
        },
        store,
        {
          policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1",
          referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
          delayOffsetsMs: [3_000, 10_000],
          requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
        },
        delay,
      );

      sidecar.enqueue(parent);
      await sidecar.drain();

      expect(delay.waitUntil).toHaveBeenCalledWith(4_000);
      expect(delay.waitUntil).toHaveBeenCalledWith(11_000);
      expect(
        store.list(parent.executionKey).map((row) => row.intendedDelayMs),
      ).toEqual([3_000, 10_000]);
    } finally {
      database.close();
    }
  });

  it("fails closed when a delayed response does not preserve request identity", async () => {
    const { database } = testStore("execution-realism-identity-");
    try {
      const store = new ExecutionRealismEvidenceStore(database);
      const sidecar = new DelayedQuoteSidecar(
        {
          getOrder: async () => ({ ...order(), outputMint: "wrong-output" }),
        },
        store,
        {
          policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1",
          referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
          delayOffsetsMs: [3_000],
          requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
        },
        immediateDelay,
      );

      sidecar.enqueue(parent);
      await sidecar.drain();

      expect(store.list(parent.executionKey)).toEqual([
        expect.objectContaining({
          outcome: "FAILURE",
          failureCode: "SCHEMA_INVALID",
          inputMint: parent.inputMint,
          outputMint: parent.outputMint,
          inputAmountRaw: parent.inputAmountRaw.toString(),
          returnedInputAmountRaw: null,
          returnedOutputAmountRaw: null,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("is idempotent across duplicate dispatch and a restarted sidecar", async () => {
    const { database } = testStore("execution-realism-idempotent-");
    try {
      const store = new ExecutionRealismEvidenceStore(database);
      const provider: JupiterOrderProvider = {
        getOrder: vi.fn(async () => order()),
      };
      const policy = {
        policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1" as const,
        referenceTimestamp:
          "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP" as const,
        delayOffsetsMs: [3_000] as const,
        requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER" as const,
      };
      const first = new DelayedQuoteSidecar(
        provider,
        store,
        policy,
        immediateDelay,
      );
      first.enqueue(parent);
      first.enqueue(parent);
      await first.drain();

      const restarted = new DelayedQuoteSidecar(
        provider,
        store,
        policy,
        immediateDelay,
      );
      restarted.enqueue(parent);
      await restarted.drain();

      expect(store.list(parent.executionKey)).toHaveLength(1);
      expect(provider.getOrder).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("contains a sidecar persistence failure and reports it without throwing", async () => {
    const failures: unknown[] = [];
    const sidecar = new DelayedQuoteSidecar(
      { getOrder: async () => order() },
      {
        has: () => false,
        append: async () => {
          throw new Error("RESEARCH_STORE_UNAVAILABLE");
        },
      },
      {
        policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1",
        referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
        delayOffsetsMs: [3_000],
        requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
      },
      immediateDelay,
      (error) => failures.push(error),
    );

    sidecar.enqueue(parent);
    await expect(sidecar.drain()).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it("treats historical parents without delayed evidence as valid but incomplete", () => {
    const { database } = testStore("execution-realism-historical-");
    try {
      const store = new ExecutionRealismEvidenceStore(database);
      expect(store.list("historical-execution")).toEqual([]);
      expect(
        store.compare({ ...parent, executionKey: "historical-execution" }),
      ).toEqual([
        {
          intendedDelayMs: 3_000,
          status: "UNAVAILABLE",
          firstQuoteOutputAmountRaw: "1000",
          delayedQuoteOutputAmountRaw: null,
          relativeOutputDecay: null,
          availabilityReason: "FORWARD_EVIDENCE_NOT_CAPTURED",
        },
        {
          intendedDelayMs: 10_000,
          status: "UNAVAILABLE",
          firstQuoteOutputAmountRaw: "1000",
          delayedQuoteOutputAmountRaw: null,
          relativeOutputDecay: null,
          availabilityReason: "FORWARD_EVIDENCE_NOT_CAPTURED",
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("rejects UPDATE and DELETE against the append-only evidence table", async () => {
    const { database } = testStore("execution-realism-append-only-");
    try {
      const store = new ExecutionRealismEvidenceStore(database);
      const sidecar = new DelayedQuoteSidecar(
        { getOrder: async () => order() },
        store,
        {
          policyVersion: "EXECUTION_REALISM_DELAY_POLICY_V1",
          referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
          delayOffsetsMs: [3_000],
          requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
        },
        immediateDelay,
      );
      sidecar.enqueue(parent);
      await sidecar.drain();

      expect(() =>
        database.sqlite
          .prepare(
            "UPDATE execution_realism_delayed_quotes SET http_status = 500",
          )
          .run(),
      ).toThrowError("APPEND_ONLY");
      expect(() =>
        database.sqlite
          .prepare("DELETE FROM execution_realism_delayed_quotes")
          .run(),
      ).toThrowError("APPEND_ONLY");
    } finally {
      database.close();
    }
  });
});
