import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { YellowstoneStreamProvider } from "../../src/stream/yellowstone-stream-provider.js";
import { envelope } from "../helpers/envelope.js";
import { MAINNET_FIXTURES, LEADER_A } from "../fixtures/mainnet-fixtures.js";
import { TestClock } from "../helpers/test-clock.js";

const transportFault = vi.hoisted(() => ({ closeDuringSubscription: false }));

vi.mock("@triton-one/yellowstone-grpc", () => ({
  CommitmentLevel: { CONFIRMED: 1 },
  default: class {
    async subscribe() {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      return {
        on(event: string, listener: (...args: unknown[]) => void) {
          listeners.set(event, listener);
          return this;
        },
        write(_request: unknown, callback: () => void) {
          callback();
          if (transportFault.closeDuringSubscription) listeners.get("end")?.();
          return true;
        },
        end() {},
        cancel() {},
      };
    }
  },
}));

describe("Yellowstone replay acknowledgement", () => {
  it("does not release replay while the subscription transport is already closed", async () => {
    transportFault.closeDuringSubscription = true;
    let delivered = 0;
    const provider = new YellowstoneStreamProvider({
      endpoint: "https://grpc.invalid",
      clock: new TestClock(),
      logger: pino({ enabled: false }),
      minBackoffMs: 1000,
      checkpoints: {
        savePendingDelivery: async () => {},
        deletePendingDelivery: async () => {},
        listPendingDeliveries: () => [],
        getCheckpoint: () => ({ slot: 100n }),
        saveCheckpoint: async () => {},
      },
      rpc: {
        getTransaction: async () => undefined,
        getTransactionsForAddress: async () => [
          { ...envelope(MAINNET_FIXTURES.jupiterBuy), slot: 101n },
        ],
        resolveAddressLookupTable: async () => [],
      },
    });
    try {
      const subscription = await provider.subscribe([LEADER_A], () => {
        delivered += 1;
      });
      await subscription.close();
      expect(delivered).toBe(0);
    } finally {
      transportFault.closeDuringSubscription = false;
    }
  });

  it("does not checkpoint a replay before its business acknowledgement", async () => {
    const transaction = {
      ...envelope(MAINNET_FIXTURES.jupiterBuy),
      slot: 101n,
    };
    let slot = 100n;
    let delivered = false;
    let acknowledge!: () => void;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const provider = new YellowstoneStreamProvider({
      endpoint: "https://grpc.invalid",
      clock: new TestClock(),
      logger: pino({ enabled: false }),
      checkpoints: {
        savePendingDelivery: async () => {},
        deletePendingDelivery: async () => {},
        listPendingDeliveries: () => [],
        getCheckpoint: () => ({ slot }),
        saveCheckpoint: async (_p, _k, next) => {
          slot = next;
        },
      },
      rpc: {
        getTransaction: async () => undefined,
        getTransactionsForAddress: async () => [transaction],
        resolveAddressLookupTable: async () => [],
      },
    });
    const started = provider.subscribe([LEADER_A], async () => {
      delivered = true;
      await pending;
    });
    while (!delivered) await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      expect(slot).toBe(100n);
    } finally {
      acknowledge();
      await (await started).close();
    }
    expect(slot).toBe(101n);
  });
});
