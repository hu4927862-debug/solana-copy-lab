import { DeliveryPolicySchema, type DeliveryPolicy } from "./protocol.js";
import { decodeWire } from "./transaction-review.js";

/** Fixed public TLS endpoint: no RPC credential or automatic provider fallback.
 * Helius' client maxRetries contract does not promise how often its backend
 * forwards a transaction. Delivery acceptance is never finalized settlement.
 * https://www.helius.dev/docs/sending-transactions/sender-swqos-only */
export const HELIUS_SWQOS_ENDPOINT = "https://sender.helius-rpc.com/fast?swqos_only=true";

export function heliusSwqosSendParams(signedTransaction: string, policy: DeliveryPolicy): unknown[] {
  const exact = DeliveryPolicySchema.parse(policy);
  decodeWire(signedTransaction);
  // The tip is already present in the independently reviewed signed message.
  // This transport never rebuilds, signs, retries or mutates those bytes.
  return [signedTransaction, {
    encoding: "base64",
    skipPreflight: exact.skipPreflight,
    preflightCommitment: exact.preflightCommitment,
    maxRetries: exact.maxRetries,
  }];
}
