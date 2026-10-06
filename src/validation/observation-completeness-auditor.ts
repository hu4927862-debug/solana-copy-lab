import bs58 from "bs58";
import type { RpcProvider } from "../domain/ports.js";
import type { StateStore } from "../persistence/state-store.js";

export interface ObservationAuditWindow {
  readonly startSlot: bigint;
  readonly endSlot: bigint;
  readonly startTimestampMs: number;
  readonly endTimestampMs: number;
  readonly targetWallets: readonly string[];
  readonly provider: string;
}

export type ObservationCompletenessStatus =
  | "OBSERVATION_COMPLETENESS_PASS"
  | "OBSERVATION_INCOMPLETE"
  | "COMPLETENESS_UNVERIFIED";

export interface ObservationCompletenessResult {
  readonly status: ObservationCompletenessStatus;
  readonly activityStatus: "TARGET_ACTIVITY_OBSERVED" | "NO_TARGET_ACTIVITY";
  readonly targetWallets: readonly string[];
  readonly startSlot: bigint;
  readonly endSlot: bigint;
  readonly startTimestampMs: number;
  readonly endTimestampMs: number;
  readonly chainSignatures: readonly string[];
  readonly liveSignatures: readonly string[];
  readonly replayedSignatures: readonly string[];
  readonly accountedSignatures: readonly string[];
  readonly missingSignatures: readonly string[];
  readonly unexpectedSignatures: readonly string[];
  readonly duplicateSignatures: readonly string[];
  readonly counts: {
    readonly chainSignatures: number;
    readonly liveReceipts: number;
    readonly replayReceipts: number;
    readonly accountedUniqueSignatures: number;
    readonly missingSignatures: number;
    readonly unexpectedSignatures: number;
    readonly duplicateSignatures: number;
  };
  readonly gapState: {
    readonly startupGapResolved: boolean;
    readonly reconnectGapsResolved: boolean;
    readonly unresolvedGapCount: number;
  };
  readonly auditError?: string;
}

interface ReceiptRow {
  readonly signature: string;
  readonly isReplay: number;
}

interface HealthRow {
  readonly type:
    | "CONNECTED"
    | "DISCONNECTED"
    | "RECONNECTED"
    | "DEGRADED"
    | "REPLAY_STARTED"
    | "REPLAY_COMPLETED"
    | "REPLAY_FAILED";
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function difference(left: readonly string[], right: Set<string>): string[] {
  return left.filter((value) => !right.has(value));
}

export function reconcileObservationSignatures(
  chainSignatures: readonly string[],
  liveSignatures: readonly string[],
  replayedSignatures: readonly string[],
): {
  readonly accountedSignatures: readonly string[];
  readonly missingSignatures: readonly string[];
  readonly unexpectedSignatures: readonly string[];
  readonly duplicateSignatures: readonly string[];
} {
  const receiptOccurrences = new Map<string, number>();
  for (const signature of [...liveSignatures, ...replayedSignatures])
    receiptOccurrences.set(
      signature,
      (receiptOccurrences.get(signature) ?? 0) + 1,
    );
  const chain = sortedUnique(chainSignatures);
  const accountedSignatures = sortedUnique(receiptOccurrences.keys());
  const chainSet = new Set(chain);
  const accountedSet = new Set(accountedSignatures);
  return {
    accountedSignatures,
    missingSignatures: difference(chain, accountedSet),
    unexpectedSignatures: difference(accountedSignatures, chainSet),
    duplicateSignatures: sortedUnique(
      [...receiptOccurrences]
        .filter(([, count]) => count > 1)
        .map(([signature]) => signature),
    ),
  };
}

function jsonSlot(slot: bigint): number {
  const value = Number(slot);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("AUDIT_SLOT_OUT_OF_SAFE_INTEGER_RANGE");
  return value;
}

type TransactionMentionResult = "MATCH" | "NO_MATCH" | "INVALID";

function isSolanaAddress(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function transactionMentionsWallet(
  transaction: { readonly payload: unknown },
  wallet: string,
): TransactionMentionResult {
  if (!transaction.payload || typeof transaction.payload !== "object")
    return "INVALID";
  const accountKeys = (transaction.payload as { accountKeys?: unknown })
    .accountKeys;
  if (!Array.isArray(accountKeys) || accountKeys.length === 0) return "INVALID";
  if (
    accountKeys.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        typeof (entry as { address?: unknown }).address !== "string" ||
        !isSolanaAddress((entry as { address: string }).address),
    )
  )
    return "INVALID";
  return accountKeys.some(
    (entry) => (entry as { address: string }).address === wallet,
  )
    ? "MATCH"
    : "NO_MATCH";
}

export class ObservationCompletenessAuditor {
  constructor(
    private readonly rpc: RpcProvider,
    private readonly state: StateStore,
  ) {}

  async audit(
    window: ObservationAuditWindow,
  ): Promise<ObservationCompletenessResult> {
    if (
      window.endSlot <= window.startSlot ||
      !Number.isSafeInteger(window.startTimestampMs) ||
      !Number.isSafeInteger(window.endTimestampMs) ||
      window.endTimestampMs < window.startTimestampMs ||
      window.targetWallets.length === 0
    ) {
      throw new Error("INVALID_OBSERVATION_AUDIT_WINDOW");
    }
    const startSlot = jsonSlot(window.startSlot);
    const endSlot = jsonSlot(window.endSlot);
    const targetWallets = sortedUnique(window.targetWallets);
    const receipts = this.state.database.sqlite
      .prepare(
        `SELECT signature, is_replay AS isReplay
         FROM provider_receipts
         WHERE provider = ?
           AND CAST(slot AS INTEGER) > ? AND CAST(slot AS INTEGER) <= ?
           AND received_timestamp_ms >= ? AND received_timestamp_ms <= ?
         ORDER BY signature, is_replay`,
      )
      .all(
        window.provider,
        startSlot,
        endSlot,
        window.startTimestampMs,
        window.endTimestampMs,
      ) as ReceiptRow[];
    const liveSignatures = sortedUnique(
      receipts.filter((row) => row.isReplay === 0).map((row) => row.signature),
    );
    const replayedSignatures = sortedUnique(
      receipts.filter((row) => row.isReplay === 1).map((row) => row.signature),
    );
    const gapState = this.gapState(window);

    let chainSignatures: string[] = [];
    let auditError: string | undefined;
    try {
      const transactions = await Promise.all(
        targetWallets.map((wallet) =>
          this.rpc.getTransactionsForAddress(wallet, {
            afterSlot: window.startSlot,
            beforeSlot: window.endSlot,
          }),
        ),
      );
      if (transactions.some((items) => items.length >= 100)) {
        auditError = "INDEPENDENT_RPC_RESULT_LIMIT_REACHED";
      } else {
        const transactionMentionResults = transactions.flatMap((items, index) =>
          items.map((transaction) => ({
            transaction,
            mention: transactionMentionsWallet(
              transaction,
              targetWallets[index]!,
            ),
          })),
        );
        if (
          transactionMentionResults.some((item) => item.mention === "INVALID")
        ) {
          auditError = "INDEPENDENT_RPC_TRANSACTION_SCHEMA_INVALID";
        }
        const transactionsInSlotWindow = transactionMentionResults
          .filter((item) => item.mention === "MATCH")
          .map((item) => item.transaction)
          .filter(
            (transaction) =>
              transaction.slot > window.startSlot &&
              transaction.slot <= window.endSlot,
          );
        if (auditError !== undefined) {
          chainSignatures = [];
        } else if (
          transactionsInSlotWindow.some(
            (transaction) => transaction.sourceTimestampMs === undefined,
          )
        ) {
          auditError = "INDEPENDENT_RPC_TIMESTAMP_UNAVAILABLE";
        } else {
          chainSignatures = sortedUnique(
            transactionsInSlotWindow
              .filter(
                (transaction) =>
                  transaction.sourceTimestampMs! >= window.startTimestampMs &&
                  transaction.sourceTimestampMs! <= window.endTimestampMs,
              )
              .map((transaction) => transaction.signature),
          );
        }
      }
    } catch {
      auditError = "INDEPENDENT_RPC_AUDIT_FAILED";
    }

    const {
      accountedSignatures,
      missingSignatures,
      unexpectedSignatures,
      duplicateSignatures,
    } = reconcileObservationSignatures(
      chainSignatures,
      liveSignatures,
      replayedSignatures,
    );
    const gapsResolved =
      gapState.startupGapResolved &&
      gapState.reconnectGapsResolved &&
      gapState.unresolvedGapCount === 0;
    const status: ObservationCompletenessStatus =
      auditError !== undefined || !gapsResolved
        ? "COMPLETENESS_UNVERIFIED"
        : missingSignatures.length > 0
          ? "OBSERVATION_INCOMPLETE"
          : "OBSERVATION_COMPLETENESS_PASS";

    return {
      status,
      activityStatus:
        chainSignatures.length === 0 && accountedSignatures.length === 0
          ? "NO_TARGET_ACTIVITY"
          : "TARGET_ACTIVITY_OBSERVED",
      targetWallets,
      startSlot: window.startSlot,
      endSlot: window.endSlot,
      startTimestampMs: window.startTimestampMs,
      endTimestampMs: window.endTimestampMs,
      chainSignatures,
      liveSignatures,
      replayedSignatures,
      accountedSignatures,
      missingSignatures,
      unexpectedSignatures,
      duplicateSignatures,
      counts: {
        chainSignatures: chainSignatures.length,
        liveReceipts: receipts.filter((row) => row.isReplay === 0).length,
        replayReceipts: receipts.filter((row) => row.isReplay === 1).length,
        accountedUniqueSignatures: accountedSignatures.length,
        missingSignatures: missingSignatures.length,
        unexpectedSignatures: unexpectedSignatures.length,
        duplicateSignatures: duplicateSignatures.length,
      },
      gapState,
      ...(auditError === undefined ? {} : { auditError }),
    };
  }

  private gapState(window: ObservationAuditWindow): {
    readonly startupGapResolved: boolean;
    readonly reconnectGapsResolved: boolean;
    readonly unresolvedGapCount: number;
  } {
    const events = this.state.database.sqlite
      .prepare(
        `SELECT type
         FROM stream_health_events
         WHERE provider = ? AND wall_timestamp_ms >= ? AND wall_timestamp_ms <= ?
         ORDER BY id`,
      )
      .all(
        window.provider,
        window.startTimestampMs,
        window.endTimestampMs,
      ) as HealthRow[];
    let openRecoveries = 0;
    let completedRecoveries = 0;
    let failedRecoveries = 0;
    let reconnects = 0;
    let disconnects = 0;
    for (const event of events) {
      if (event.type === "DISCONNECTED") disconnects += 1;
      if (event.type === "RECONNECTED") reconnects += 1;
      if (event.type === "REPLAY_STARTED") openRecoveries += 1;
      if (event.type === "REPLAY_COMPLETED") {
        completedRecoveries += 1;
        openRecoveries = Math.max(0, openRecoveries - 1);
      }
      if (event.type === "REPLAY_FAILED") failedRecoveries += 1;
    }
    const expectedRecoveries = 1 + Math.max(disconnects, reconnects);
    const unresolvedGapCount = Math.max(
      openRecoveries,
      expectedRecoveries - completedRecoveries,
      failedRecoveries,
    );
    return {
      startupGapResolved: completedRecoveries >= 1 && failedRecoveries === 0,
      reconnectGapsResolved:
        completedRecoveries >= expectedRecoveries && failedRecoveries === 0,
      unresolvedGapCount,
    };
  }
}
