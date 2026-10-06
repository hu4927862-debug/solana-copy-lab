import { describe, expect, it } from "vitest";
import type {
  RpcProvider,
  StreamTransactionEnvelope,
} from "../../src/domain/ports.js";
import { GapRecovery } from "../../src/recovery/gap-recovery.js";
import type { StreamCheckpointStore } from "../../src/stream/checkpoint-store.js";
import { envelope } from "../helpers/envelope.js";
import { MAINNET_FIXTURES } from "../fixtures/mainnet-fixtures.js";

class MemoryCheckpointStore implements StreamCheckpointStore {
  checkpoint: { slot: bigint; signature?: string } | undefined = { slot: 100n };
  async saveCheckpoint(
    _provider: string,
    _key: string,
    slot: bigint,
    signature?: string,
  ): Promise<void> {
    this.checkpoint = {
      slot,
      ...(signature === undefined ? {} : { signature }),
    };
  }
  getCheckpoint(): { slot: bigint; signature?: string } | undefined {
    return this.checkpoint;
  }
}

describe("gap recovery and RPC failure handling", () => {
  it("delivers nothing and preserves the boundary when one wallet scan fails", async () => {
    const checkpoints = new MemoryCheckpointStore();
    const emitted: string[] = [];
    const rpc: RpcProvider = {
      getTransaction: async () => undefined,
      getTransactionsForAddress: async (wallet) => {
        if (wallet === "unavailable") throw new Error("RPC_TIMEOUT");
        return [{ ...envelope(MAINNET_FIXTURES.jupiterBuy), slot: 101n }];
      },
      resolveAddressLookupTable: async () => [],
    };
    await expect(
      new GapRecovery(rpc, checkpoints, { maxAttempts: 1 }).recover(
        "ws",
        "targets",
        ["healthy", "unavailable"],
        (item) => emitted.push(item.signature),
      ),
    ).rejects.toThrow("RPC_TIMEOUT");
    expect(emitted).toEqual([]);
    expect(checkpoints.checkpoint?.slot).toBe(100n);
  });

  it("keeps the durable checkpoint when downstream delivery fails asynchronously", async () => {
    const checkpoints = new MemoryCheckpointStore();
    const first = { ...envelope(MAINNET_FIXTURES.jupiterBuy), slot: 101n };
    const second = { ...envelope(MAINNET_FIXTURES.raydiumBuy), slot: 102n };
    const rpc: RpcProvider = {
      getTransaction: async () => undefined,
      getTransactionsForAddress: async () => [first, second],
      resolveAddressLookupTable: async () => [],
    };
    const result = new GapRecovery(rpc, checkpoints).recover(
      "ws",
      "targets",
      ["wallet"],
      async (item) => {
        if (item.signature === second.signature)
          throw new Error("DISK_WRITE_FAILED");
      },
    );
    await expect(result).rejects.toThrow("DISK_WRITE_FAILED");
    expect(checkpoints.checkpoint?.slot).toBe(100n);
  });

  it("includes the checkpoint slot so another signature in that slot is recovered", async () => {
    const checkpoints = new MemoryCheckpointStore();
    const tail = { ...envelope(MAINNET_FIXTURES.jupiterBuy), slot: 100n };
    const rpc: RpcProvider = {
      getTransaction: async () => undefined,
      getTransactionsForAddress: async (_wallet, options) =>
        tail.slot > options.afterSlot ? [tail] : [],
      resolveAddressLookupTable: async () => [],
    };
    const delivered: string[] = [];
    await new GapRecovery(rpc, checkpoints).recover(
      "ws",
      "targets",
      ["wallet"],
      (item) => {
        delivered.push(item.signature);
      },
    );
    expect(delivered).toEqual([tail.signature]);
  });
  it("recovers in slot order and deduplicates signatures across wallets", async () => {
    const first = envelope(MAINNET_FIXTURES.jupiterBuy);
    const second: StreamTransactionEnvelope = {
      ...envelope(MAINNET_FIXTURES.raydiumBuy),
      slot: first.slot + 1n,
    };
    const rpc: RpcProvider = {
      getTransaction: async () => undefined,
      getTransactionsForAddress: async (wallet) =>
        wallet === "wallet-a" ? [second, first] : [first],
      resolveAddressLookupTable: async () => [],
    };
    const checkpoints = new MemoryCheckpointStore();
    const emitted: string[] = [];
    const count = await new GapRecovery(rpc, checkpoints).recover(
      "yellowstone",
      "targets",
      ["wallet-a", "wallet-b"],
      (item) => emitted.push(item.signature),
    );
    expect(count).toBe(2);
    expect(emitted).toEqual([first.signature, second.signature]);
    expect(checkpoints.checkpoint?.slot).toBe(second.slot);
  });

  it("retries after an RPC timeout and does not lose the gap", async () => {
    let calls = 0;
    const recovered = envelope(MAINNET_FIXTURES.jupiterBuy);
    const rpc: RpcProvider = {
      getTransaction: async () => undefined,
      getTransactionsForAddress: async () => {
        calls += 1;
        if (calls === 1)
          return new Promise<readonly StreamTransactionEnvelope[]>(
            () => undefined,
          );
        return [recovered];
      },
      resolveAddressLookupTable: async () => [],
    };
    const emitted: string[] = [];
    const count = await new GapRecovery(rpc, new MemoryCheckpointStore(), {
      timeoutMs: 5,
      maxAttempts: 2,
      baseBackoffMs: 0,
      sleep: async () => undefined,
    }).recover("yellowstone", "targets", ["wallet-a"], (item) =>
      emitted.push(item.signature),
    );
    expect(calls).toBe(2);
    expect(count).toBe(1);
    expect(emitted).toEqual([recovered.signature]);
  });
});
