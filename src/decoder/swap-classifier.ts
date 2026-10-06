import {
  canonicalDomainQuoteMint,
  NATIVE_SOL,
  QUOTE_ASSETS,
  type AssetDelta,
} from "../domain/assets.js";
import { stableId } from "../domain/ids.js";
import type { SwapClassification, SwapEvent } from "../domain/trades.js";
import { AssetDeltaEngine } from "./asset-delta-engine.js";
import { SwapEvidenceValidator } from "./swap-evidence-validator.js";
import type { NormalizedTransaction } from "./transaction-normalizer.js";
import { nativeSolPrincipal } from "./native-sol-principal.js";

function reject(
  code: Exclude<SwapClassification, { accepted: true }>["code"],
  details: string,
): SwapClassification {
  return { accepted: false, code, details };
}

export class SwapClassifier {
  constructor(
    private readonly deltaEngine = new AssetDeltaEngine(),
    private readonly evidenceValidator = new SwapEvidenceValidator(),
  ) {}

  classify(
    transaction: NormalizedTransaction,
    leaderWallet: string,
  ): SwapClassification {
    if (!transaction.success)
      return reject(
        "TRANSACTION_FAILED",
        transaction.error ?? "transaction failed",
      );
    const leaderAccount = transaction.accountKeys.find(
      (account) => account.address === leaderWallet,
    );
    if (!leaderAccount?.signer)
      return reject("LEADER_NOT_SIGNER", "leader is not a transaction signer");

    const deltaResult = this.deltaEngine.calculate(transaction, leaderWallet);
    if (deltaResult.ambiguousOwnership)
      return reject(
        "AMBIGUOUS_OWNERSHIP",
        "changed token account has no owner",
      );
    if (deltaResult.missingDecimals)
      return reject(
        "MISSING_DECIMALS",
        "changed token balance has no decimals",
      );
    if (deltaResult.unsupportedToken2022) {
      return reject(
        "UNSUPPORTED_TOKEN_2022",
        "unsupported Token-2022 extension changed balance",
      );
    }
    const nonZero = deltaResult.deltas.filter((delta) => delta.raw !== 0n);
    if (nonZero.length < 2)
      return reject(
        "NO_ASSET_DELTA",
        "fewer than two leader-owned assets changed",
      );

    const evidence = this.evidenceValidator.validate(transaction);
    if (evidence.liquidityOperation)
      return reject("LIQUIDITY_OPERATION", "liquidity evidence present");
    if (evidence.stakeOrLending)
      return reject("STAKE_OR_LENDING", "stake or lending evidence present");
    if (evidence.ordinaryTransfer)
      return reject("ORDINARY_TRANSFER", "only transfer evidence present");
    if (!evidence.hasKnownProgram || !evidence.dex) {
      return reject(
        "UNKNOWN_SWAP_PROGRAM",
        "no allow-listed swap program invoked",
      );
    }
    if (!evidence.hasSwapEvidence)
      return reject("NO_SWAP_EVIDENCE", "known program without swap semantics");

    let quoteDeltas = nonZero.filter((delta) => QUOTE_ASSETS.has(delta.mint));
    if (
      quoteDeltas.length > 1 &&
      quoteDeltas.some((delta) => delta.mint !== NATIVE_SOL)
    ) {
      quoteDeltas = quoteDeltas.filter(
        (delta) =>
          delta.mint !== NATIVE_SOL ||
          (delta.raw < 0n ? -delta.raw : delta.raw) > 10_000_000n,
      );
    }
    if (quoteDeltas.length === 0)
      return reject("NO_QUOTE_ASSET", "no SOL/WSOL/USDC/USDT delta");
    if (quoteDeltas.length !== 1)
      return reject("AMBIGUOUS_DIRECTION", "multiple quote assets changed");
    const tokenDeltas = nonZero.filter(
      (delta) => !QUOTE_ASSETS.has(delta.mint),
    );
    if (tokenDeltas.length === 0)
      return reject("TOKEN_TO_TOKEN", "quote-to-quote route is unsupported");
    if (tokenDeltas.length !== 1)
      return reject("AMBIGUOUS_DIRECTION", "multiple non-quote assets changed");

    let quoteDelta = quoteDeltas[0] as AssetDelta;
    let principalProof: string | undefined;
    if (quoteDelta.mint === NATIVE_SOL) {
      const principal = nativeSolPrincipal(transaction, leaderWallet);
      if (principal.ambiguous)
        return reject(
          "NATIVE_SOL_PRINCIPAL_UNAVAILABLE",
          "native wallet delta includes movements without isolated swap principal",
        );
      if (principal.raw !== undefined) {
        quoteDelta = { ...quoteDelta, raw: principal.raw };
        principalProof = principal.proofVersion ?? "SPL_WSOL_TRANSFERS_V1";
      }
    }
    const tokenDelta = tokenDeltas[0] as AssetDelta;
    const isBuy = quoteDelta.raw < 0n && tokenDelta.raw > 0n;
    const isSell = quoteDelta.raw > 0n && tokenDelta.raw < 0n;
    if (!isBuy && !isSell)
      return reject(
        "AMBIGUOUS_DIRECTION",
        "asset delta signs do not form BUY or SELL",
      );

    const side = isBuy ? "BUY" : "SELL";
    const eventIndex = 0;
    const event: SwapEvent = {
      id: stableId("swap", leaderWallet, transaction.signature, eventIndex),
      signature: transaction.signature,
      eventIndex,
      slot: transaction.slot,
      leaderWallet,
      side,
      token: {
        mint: tokenDelta.mint,
        raw: tokenDelta.raw < 0n ? -tokenDelta.raw : tokenDelta.raw,
        decimals: tokenDelta.decimals,
      },
      quote: {
        mint: canonicalDomainQuoteMint(quoteDelta.mint),
        raw: quoteDelta.raw < 0n ? -quoteDelta.raw : quoteDelta.raw,
        decimals: quoteDelta.decimals,
      },
      leaderPreTokenRaw: tokenDelta.preRaw,
      deltas: nonZero,
      dex: evidence.dex,
      evidence: [
        ...evidence.evidence,
        ...(principalProof ? [`QUOTE_PRINCIPAL:${principalProof}`] : []),
      ],
      timestamps: {
        ...(transaction.sourceTimestampMs === undefined
          ? {}
          : { sourceTimestampMs: transaction.sourceTimestampMs }),
        sourceTimestampPrecision: transaction.sourceTimestampPrecision,
        sourceTimestampProvenance: transaction.sourceTimestampProvenance,
        streamReceivedTimestampMs: transaction.streamReceivedTimestampMs,
        detectedTimestampMs: transaction.detectedTimestampMs,
        decodedTimestampMs: transaction.decodedTimestampMs,
        streamReceivedMonotonicNs: transaction.streamReceivedMonotonicNs,
        detectedMonotonicNs: transaction.detectedMonotonicNs,
        decodedMonotonicNs: transaction.decodedMonotonicNs,
      },
    };
    return { accepted: true, event };
  }
}
