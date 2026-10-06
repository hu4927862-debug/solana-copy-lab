import { stableId } from "../domain/ids.js";
import type { ExecutionIntent } from "../domain/execution.js";
import type { Position } from "../domain/positions.js";
import type { SwapEvent } from "../domain/trades.js";

export interface CopyPolicy {
  readonly followerWallet: string;
  readonly copyRatioBps: number;
  readonly maxQuoteRaw?: bigint;
  readonly mode: "PAPER" | "SHADOW";
}

export class CopyEngine {
  decide(
    event: SwapEvent,
    policy: CopyPolicy,
    position?: Position,
  ): ExecutionIntent {
    if (
      !Number.isInteger(policy.copyRatioBps) ||
      policy.copyRatioBps < 0 ||
      policy.copyRatioBps > 100_000
    ) {
      throw new Error("copyRatioBps must be an integer between 0 and 100000");
    }

    let theoreticalTokenRaw = 0n;
    let theoreticalQuoteRaw = 0n;
    let sellRatio: ExecutionIntent["sellRatio"];
    let skipReason: string | undefined;
    let diagnosticCode: string | undefined;

    if (event.side === "BUY") {
      theoreticalQuoteRaw =
        (event.quote.raw * BigInt(policy.copyRatioBps)) / 10_000n;
      if (
        policy.maxQuoteRaw !== undefined &&
        theoreticalQuoteRaw > policy.maxQuoteRaw
      ) {
        theoreticalQuoteRaw = policy.maxQuoteRaw;
      }
      theoreticalTokenRaw =
        event.quote.raw === 0n
          ? 0n
          : (event.token.raw * theoreticalQuoteRaw) / event.quote.raw;
      if (theoreticalQuoteRaw === 0n || theoreticalTokenRaw === 0n)
        skipReason = "SIZE_ROUNDED_TO_ZERO";
    } else {
      const denominator = event.leaderPreTokenRaw;
      const numerator = event.token.raw;
      sellRatio = { numerator, denominator };
      if (denominator <= 0n) skipReason = "LEADER_PRE_BALANCE_ZERO";
      else if (numerator > denominator)
        skipReason = "LEADER_SELL_EXCEEDS_PRE_BALANCE";
      else if (!position || position.rawAmount <= 0n) {
        skipReason = "NO_MAPPED_POSITION";
        diagnosticCode =
          position?.state === "CLOSED"
            ? "OBSERVED_POSITION_STATE_CLOSED"
            : "MAPPING_ABSENT_OR_UNRESOLVED";
      } else if (position.accountingPolicyVersion !== "WEIGHTED_AVERAGE_V1")
        skipReason = "LEGACY_POSITION_COST_BASIS_UNAVAILABLE";
      else if (position.quoteMint !== event.quote.mint)
        skipReason = "POSITION_QUOTE_MISMATCH";
      else {
        theoreticalTokenRaw = (position.rawAmount * numerator) / denominator;
        if (numerator === denominator) theoreticalTokenRaw = position.rawAmount;
        theoreticalQuoteRaw =
          event.token.raw === 0n
            ? 0n
            : (event.quote.raw * theoreticalTokenRaw) / event.token.raw;
        if (theoreticalTokenRaw === 0n) skipReason = "SIZE_ROUNDED_TO_ZERO";
      }
    }

    const executionKey = stableId(
      "exec",
      event.id,
      policy.followerWallet,
      policy.copyRatioBps,
      theoreticalTokenRaw,
      theoreticalQuoteRaw,
      policy.mode,
    );
    return {
      executionKey,
      leaderTradeId: event.id,
      leaderWallet: event.leaderWallet,
      followerWallet: policy.followerWallet,
      mode: policy.mode,
      side: event.side,
      tokenMint: event.token.mint,
      quoteMint: event.quote.mint,
      theoreticalTokenRaw,
      theoreticalQuoteRaw,
      copyRatioBps: policy.copyRatioBps,
      ...(sellRatio === undefined ? {} : { sellRatio }),
      ...(skipReason === undefined ? {} : { skipReason }),
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
      ...(event.timestamps.sourceTimestampMs === undefined ||
      event.timestamps.sourceTimestampProvenance !== "CHAIN_BLOCK_TIME" ||
      (event.timestamps.sourceTimestampPrecision !== "MILLISECOND" &&
        event.timestamps.sourceTimestampPrecision !== "SECOND")
        ? {}
        : {
            authoritativeSourceTimestamp: {
              valueMs: event.timestamps.sourceTimestampMs,
              provenance: "CHAIN_BLOCK_TIME",
              precision: event.timestamps.sourceTimestampPrecision,
            },
          }),
      createdAtMs: event.timestamps.decodedTimestampMs,
      createdMonotonicNs: event.timestamps.decodedMonotonicNs,
    };
  }
}
