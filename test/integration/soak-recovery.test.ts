import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/telemetry/logger.js";
import { RecoveryValidator } from "../../src/validation/recovery-validator.js";
import { SoakMonitor } from "../../src/validation/soak-monitor.js";
import { ValidationStore } from "../../src/validation/validation-store.js";
import { envelope } from "../helpers/envelope.js";
import { testStore } from "../helpers/database.js";
import { TestClock } from "../helpers/test-clock.js";
import { MAINNET_FIXTURES } from "../fixtures/mainnet-fixtures.js";

describe("soak and recovery validation", () => {
  it("samples SQLite WAL, writer health, and checkpoint latency", async () => {
    const { database } = testStore("soak-monitor-");
    const monitor = new SoakMonitor(database, createLogger("error"), 10);
    await monitor.sample();
    const row = database.sqlite
      .prepare("SELECT * FROM soak_metrics ORDER BY id DESC LIMIT 1")
      .get() as Record<string, number>;
    expect(row.db_size_bytes).toBeGreaterThan(0);
    expect(row.busy_error_count).toBe(0);
    expect(row.wal_checkpoint_duration_ms).toBeGreaterThanOrEqual(0);
    database.close();
  });

  it("validates kill/restart recovery from passive receipts and replay evidence", async () => {
    const { database } = testStore("kill-restart-");
    const clock = new TestClock();
    const store = new ValidationStore(database, clock, {
      primary: "primary",
      secondary: "secondary",
    });
    const validator = new RecoveryValidator(undefined, store, database, {
      primary: "primary",
      secondary: "secondary",
    });
    const id = await validator.beginKillRestart();
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    await store.recordProviderReceipt("secondary", {
      ...transaction,
      streamReceivedTimestampMs: 1_730_000_000_205,
    });
    await store.recordProviderReceipt(
      "primary",
      { ...transaction, streamReceivedTimestampMs: 1_730_000_000_250 },
      true,
    );
    const result = await validator.completeKillRestart(id, 1_730_000_000_300);
    expect(result).toMatchObject({
      eventsDuringOutage: 1,
      recoveredEvents: 1,
      lostEvents: 0,
      status: "PASS",
    });
    database.close();
  });
});
