import { describe, it, expect } from "vitest";
import { SqliteDatabase } from "../../src/persistence/database.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { testStore } from "../helpers/database.js";
import { TestClock } from "../helpers/test-clock.js";

describe("durable stream delivery gaps", () => {
  it("retains unacknowledged signatures independently of the latest checkpoint", async () => {
    const { store, database, path } = testStore();
    let reopened: SqliteDatabase | undefined;
    try {
      await store.savePendingDelivery("ws", "leaders", 100n, "missing");
      await store.saveCheckpoint("ws", "leaders", 102n, "later");
      database.close();
      reopened = new SqliteDatabase({
        path,
        migrationsDirectory: "migrations",
      });
      const restarted = new StateStore(
        reopened,
        new TestClock(),
        store.riskPolicy,
      );
      expect(restarted.listPendingDeliveries("ws", "leaders")).toEqual([
        { slot: 100n, signature: "missing" },
      ]);
      expect(restarted.listPendingDeliveries("ws", "other")).toEqual([]);
      await restarted.deletePendingDelivery("ws", "leaders", "missing");
      expect(restarted.listPendingDeliveries("ws", "leaders")).toEqual([]);
    } finally {
      if (reopened) reopened.close();
      else if (database.sqlite.open) database.close();
    }
  });
});
