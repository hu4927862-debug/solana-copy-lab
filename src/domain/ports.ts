import type { ExecutionIntent, ExecutionResult } from "./execution.js";

export interface StreamTransactionEnvelope {
  readonly signature: string;
  readonly slot: bigint;
  readonly sourceTimestampMs?: number;
  readonly sourceTimestampPrecision:
    "MILLISECOND" | "SECOND" | "SLOT_ONLY" | "UNKNOWN";
  readonly sourceTimestampProvenance: "CHAIN_BLOCK_TIME" | "UNKNOWN";
  readonly streamReceivedTimestampMs: number;
  readonly streamReceivedMonotonicNs: bigint;
  readonly payload: unknown;
  readonly deliveryType?: "LIVE" | "REPLAY";
}

export interface StreamSubscription {
  updateTargets(wallets: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export interface StreamProvider {
  subscribe(
    wallets: readonly string[],
    onTransaction: (envelope: StreamTransactionEnvelope) => unknown,
  ): Promise<StreamSubscription>;
}

export interface RpcProvider {
  pendingCount?(): number;
  getCurrentSlot?(options?: { readonly signal?: AbortSignal }): Promise<bigint>;
  getTransaction(
    signature: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<StreamTransactionEnvelope | undefined>;
  getTransactionsForAddress(
    address: string,
    options: {
      readonly afterSlot: bigint;
      readonly beforeSlot?: bigint;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly StreamTransactionEnvelope[]>;
  resolveAddressLookupTable(address: string): Promise<readonly string[]>;
}

export interface TransactionSender {
  readonly mode: "PAPER" | "SHADOW";
  send(
    intent: ExecutionIntent,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExecutionResult>;
  lookup(executionKey: string): Promise<ExecutionResult | undefined>;
}
