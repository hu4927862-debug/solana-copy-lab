import { NATIVE_SOL, type AssetDelta } from "../domain/assets.js";
import type {
  NormalizedTokenBalance,
  NormalizedTransaction,
} from "./transaction-normalizer.js";

interface BalancePair {
  pre?: NormalizedTokenBalance;
  post?: NormalizedTokenBalance;
}

export interface DeltaResult {
  readonly deltas: readonly AssetDelta[];
  readonly ambiguousOwnership: boolean;
  readonly missingDecimals: boolean;
  readonly unsupportedToken2022: boolean;
}

export class AssetDeltaEngine {
  calculate(transaction: NormalizedTransaction, owner: string): DeltaResult {
    const pairs = new Map<string, BalancePair>();
    for (const balance of transaction.preTokenBalances) {
      const key = `${balance.accountIndex}:${balance.mint}`;
      pairs.set(key, { pre: balance });
    }
    for (const balance of transaction.postTokenBalances) {
      const key = `${balance.accountIndex}:${balance.mint}`;
      const current = pairs.get(key) ?? {};
      pairs.set(key, { ...current, post: balance });
    }

    const deltas: AssetDelta[] = [];
    let ambiguousOwnership = false;
    let missingDecimals = false;
    let unsupportedToken2022 = false;

    for (const pair of pairs.values()) {
      const sample = pair.post ?? pair.pre;
      if (!sample) continue;
      const pairOwner = pair.post?.owner ?? pair.pre?.owner;
      if (!pairOwner) {
        if ((pair.pre?.rawAmount ?? 0n) !== (pair.post?.rawAmount ?? 0n))
          ambiguousOwnership = true;
        continue;
      }
      if (pairOwner !== owner) continue;
      const decimals = pair.post?.decimals ?? pair.pre?.decimals;
      if (decimals === null || decimals === undefined) {
        missingDecimals = true;
        continue;
      }
      if (
        sample.tokenProgram === "TOKEN_2022" &&
        (sample.unsupportedExtension ||
          pair.pre?.unsupportedExtension ||
          pair.post?.unsupportedExtension)
      ) {
        unsupportedToken2022 = true;
        continue;
      }
      const preRaw = pair.pre?.rawAmount ?? 0n;
      const postRaw = pair.post?.rawAmount ?? 0n;
      if (preRaw === postRaw) continue;
      deltas.push({
        mint: sample.mint,
        owner,
        preRaw,
        postRaw,
        raw: postRaw - preRaw,
        decimals,
      });
    }

    const ownerIndex = transaction.accountKeys.findIndex(
      (key) => key.address === owner,
    );
    if (ownerIndex >= 0) {
      const preRaw = transaction.preBalances[ownerIndex];
      const postRaw = transaction.postBalances[ownerIndex];
      if (preRaw !== undefined && postRaw !== undefined) {
        let raw = postRaw - preRaw;
        if (transaction.feePayer === owner) raw += transaction.feeRaw;
        if (raw !== 0n) {
          deltas.push({
            mint: NATIVE_SOL,
            owner,
            preRaw,
            postRaw,
            raw,
            decimals: 9,
          });
        }
      }
    }

    return {
      deltas,
      ambiguousOwnership,
      missingDecimals,
      unsupportedToken2022,
    };
  }
}
