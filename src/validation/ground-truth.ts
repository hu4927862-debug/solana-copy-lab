import { QUOTE_ASSETS } from "../domain/assets.js";
import type { SwapClassification } from "../domain/trades.js";
import { AssetDeltaEngine } from "../decoder/asset-delta-engine.js";
import { SwapEvidenceValidator } from "../decoder/swap-evidence-validator.js";
import type { NormalizedTransaction } from "../decoder/transaction-normalizer.js";
import type { GroundTruthResult, ValidationClassification } from "./types.js";

function rejectedSystemClassification(
  classification: Exclude<SwapClassification, { accepted: true }>,
): ValidationClassification {
  if (classification.code === "ORDINARY_TRANSFER") return "TRANSFER";
  if (classification.code === "LIQUIDITY_OPERATION") return "LP";
  if (classification.code === "STAKE_OR_LENDING") {
    return /stake/i.test(classification.details) ? "STAKE" : "LENDING";
  }
  if (
    classification.code === "UNSUPPORTED_TOKEN_2022" ||
    classification.code === "TOKEN_TO_TOKEN"
  ) {
    return "UNSUPPORTED";
  }
  return "UNKNOWN";
}

export class GroundTruthClassifier {
  private readonly deltas = new AssetDeltaEngine();
  private readonly evidence = new SwapEvidenceValidator();

  classify(
    transaction: NormalizedTransaction,
    leader: string,
    system: SwapClassification,
  ): GroundTruthResult {
    if (system.accepted) {
      return {
        classification: system.event.side,
        source: "AUTO_RULE",
        reviewReason: "SWAP_LABEL_REQUIRES_HUMAN_REVIEW",
      };
    }

    const evidence = this.evidence.validate(transaction);
    if (evidence.liquidityOperation)
      return { classification: "LP", source: "AUTO_RULE" };
    if (evidence.stakeOrLending) {
      const text = [
        ...transaction.logMessages,
        ...transaction.outerInstructions.map((item) => item.parsedType ?? ""),
      ].join(" ");
      return {
        classification: /stake/i.test(text) ? "STAKE" : "LENDING",
        source: "AUTO_RULE",
      };
    }
    if (evidence.ordinaryTransfer)
      return { classification: "TRANSFER", source: "AUTO_RULE" };

    const deltaResult = this.deltas.calculate(transaction, leader);
    const quotes = deltaResult.deltas.filter((delta) =>
      QUOTE_ASSETS.has(delta.mint),
    );
    const tokens = deltaResult.deltas.filter(
      (delta) => !QUOTE_ASSETS.has(delta.mint),
    );
    if (
      evidence.hasKnownProgram &&
      evidence.hasSwapEvidence &&
      quotes.length === 1 &&
      tokens.length === 1
    ) {
      const quote = quotes[0]!;
      const token = tokens[0]!;
      if (quote.raw < 0n && token.raw > 0n) {
        return {
          classification: "BUY",
          source: "AUTO_RULE",
          reviewReason: `CLASSIFIER_CONFLICT:${system.code}`,
        };
      }
      if (quote.raw > 0n && token.raw < 0n) {
        return {
          classification: "SELL",
          source: "AUTO_RULE",
          reviewReason: `CLASSIFIER_CONFLICT:${system.code}`,
        };
      }
    }

    const fallback = rejectedSystemClassification(system);
    return {
      classification: fallback,
      source: "AUTO_RULE",
      ...(fallback === "UNKNOWN" || fallback === "UNSUPPORTED"
        ? { reviewReason: `${fallback}:${system.code}` }
        : {}),
    };
  }
}
