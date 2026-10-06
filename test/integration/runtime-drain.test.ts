import { describe, expect, it, vi } from "vitest";
import { drainRuntime } from "../../src/app/runtime-drain.js";
import { testStore } from "../helpers/database.js";

describe("offline runtime drain diagnostics", () => {
  it("records every durable pending identity and queue count before rejecting incomplete drain", async () => {
    const { database, store } = testStore("runtime-drain-");
    const records: unknown[] = [];
    try {
      await store.savePendingDelivery("ws", "leaders", 100n, "first");
      await store.savePendingDelivery("ws", "leaders", 101n, "second");
      await expect(
        drainRuntime({
          database,
          stages: [],
          counts: () => ({
            queueDepth: 2,
            recoveryPending: 1,
            transportPending: 3,
          }),
          record: (snapshot) => {
            records.push(snapshot);
          },
        }),
      ).rejects.toThrow("CANARY_DRAIN_INCOMPLETE");
      expect(records).toEqual([
        expect.objectContaining({
          queueDepth: 2,
          recoveryPending: 1,
          transportPending: 3,
          streamPending: 2,
          disposition: "INCOMPLETE",
          pendingDeliveries: [
            {
              provider: "ws",
              subscriptionKey: "leaders",
              slot: "100",
              signature: "first",
            },
            {
              provider: "ws",
              subscriptionKey: "leaders",
              slot: "101",
              signature: "second",
            },
          ],
        }),
      ]);
    } finally {
      database.close();
    }
  });
  it("records diagnostics even when an earlier stop stage rejects and finishes later cleanup", async () => {
    const { database } = testStore("runtime-drain-fault-");
    const order: string[] = [];
    try {
      await expect(
        drainRuntime({
          database,
          stages: [
            {
              name: "stream",
              run: async () => {
                throw new Error("sensitive upstream text");
              },
            },
            {
              name: "writer",
              run: async () => {
                order.push("writer");
              },
            },
          ],
          counts: () => ({
            queueDepth: 0,
            recoveryPending: 0,
            transportPending: 0,
          }),
          record: (snapshot) => {
            order.push("diagnostics");
            expect(snapshot.stageFailures).toEqual(["stream"]);
            expect(JSON.stringify(snapshot)).not.toContain("sensitive");
          },
        }),
      ).rejects.toThrow("CANARY_DRAIN_INCOMPLETE");
      expect(order).toEqual(["writer", "diagnostics"]);
    } finally {
      database.close();
    }
  });
  it("reports completion only after all deliveries are acknowledged", async () => {
    const { database, store } = testStore("runtime-drain-ok-");
    try {
      await store.savePendingDelivery("ws", "leaders", 100n, "acknowledged");
      const result = await drainRuntime({
        database,
        stages: [
          {
            name: "stream",
            run: () =>
              store.deletePendingDelivery("ws", "leaders", "acknowledged"),
          },
        ],
        counts: () => ({
          queueDepth: 0,
          recoveryPending: 0,
          transportPending: 0,
        }),
        record: () => {},
      });
      expect(result).toMatchObject({
        streamPending: 0,
        pendingDeliveries: [],
        disposition: "DRAINED",
      });
    } finally {
      database.close();
    }
  });
});

it("bounds a noncooperative stop and records pending diagnostics instead of hanging", async () => {
  const { database, store } = testStore("drain-hang-");
  const records: any[] = [];
  try {
    await store.savePendingDelivery("ws", "fixed", 9n, "unacked");
    // A real 10 ms timeout may fire just before the monotonic deadline on a
    // busy host. Exercise the deadline exactly, without changing runtime code.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const rejected = expect(
      drainRuntime({
        database,
        timeoutMs: 10,
        stages: [
          { name: "noncooperative", run: () => new Promise(() => {}) },
          { name: "writer", run: () => database.writer.onIdle() },
        ],
        counts: () => ({
          queueDepth: 1,
          recoveryPending: 0,
          transportPending: 1,
        }),
        record: (r) => records.push(r),
      }),
    ).rejects.toThrow("CANARY_DRAIN_INCOMPLETE");
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(records[0]).toMatchObject({
      disposition: "INCOMPLETE",
      streamPending: 1,
      stageFailures: ["noncooperative", "writer"],
    });
  } finally {
    vi.useRealTimers();
    database.close();
  }
});
