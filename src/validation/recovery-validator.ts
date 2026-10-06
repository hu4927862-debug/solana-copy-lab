import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../persistence/database.js";
import type { DualStreamCoordinator } from "../stream/dual-stream-coordinator.js";
import type { ValidationStore } from "./validation-store.js";

export type RecoveryScenario =
  "STREAM_15S_DISCONNECT" | "KILL_9_RESTART" | "PRIMARY_DOWN";

export interface RecoveryValidationResult {
  readonly id: string;
  readonly scenario: RecoveryScenario;
  readonly eventsDuringOutage: number;
  readonly recoveredEvents: number;
  readonly lostEvents: number;
  readonly duplicateEvents: number;
  readonly replayCount: number;
  readonly replaySuccessCount: number;
  readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class RecoveryValidator {
  constructor(
    private readonly stream: DualStreamCoordinator | undefined,
    private readonly store: ValidationStore,
    private readonly database: SqliteDatabase,
    private readonly providers: {
      readonly primary: string;
      readonly secondary: string;
    },
  ) {}

  async injectPrimaryOutage(
    scenario: "STREAM_15S_DISCONNECT" | "PRIMARY_DOWN",
    durationMs = 15_000,
    settleMs = 5_000,
  ): Promise<RecoveryValidationResult> {
    const id = randomUUID();
    const startedAtMs = Date.now();
    await this.store.beginRecoveryRun(id, scenario, { durationMs, settleMs });
    if (!this.stream)
      throw new Error("Stream coordinator is required for outage injection");
    await this.stream.injectPrimaryDisconnect(durationMs);
    await delay(durationMs + settleMs);
    return this.complete(id, scenario, startedAtMs, startedAtMs + durationMs);
  }

  async beginKillRestart(): Promise<string> {
    const id = randomUUID();
    await this.store.beginRecoveryRun(id, "KILL_9_RESTART", {
      marker: "PRE_KILL",
    });
    return id;
  }

  async completeKillRestart(
    id: string,
    outageEndedAtMs = Date.now(),
  ): Promise<RecoveryValidationResult> {
    const row = this.database.sqlite
      .prepare(
        "SELECT started_at_ms AS startedAtMs FROM recovery_validation_runs WHERE id=? AND scenario='KILL_9_RESTART'",
      )
      .get(id) as { startedAtMs: number } | undefined;
    if (!row) throw new Error(`Unknown KILL_9_RESTART recovery run: ${id}`);
    return this.complete(
      id,
      "KILL_9_RESTART",
      row.startedAtMs,
      outageEndedAtMs,
    );
  }

  private async complete(
    id: string,
    scenario: RecoveryScenario,
    outageStartedAtMs: number,
    outageEndedAtMs: number,
  ): Promise<RecoveryValidationResult> {
    await this.store.drain();
    const secondarySignatures = this.database.sqlite
      .prepare(
        `SELECT signature FROM provider_receipts
         WHERE provider=? AND received_timestamp_ms BETWEEN ? AND ?`,
      )
      .all(
        this.providers.secondary,
        outageStartedAtMs,
        outageEndedAtMs,
      ) as Array<{ signature: string }>;
    const recovered = secondarySignatures.filter(
      (item) =>
        this.database.sqlite
          .prepare(
            "SELECT 1 FROM provider_receipts WHERE signature=? AND provider=? AND is_replay=1",
          )
          .get(item.signature, this.providers.primary) !== undefined,
    ).length;
    const replayCount = Number(
      (
        this.database.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM provider_receipts WHERE provider=? AND is_replay=1 AND created_at_ms>=?",
          )
          .get(this.providers.primary, outageStartedAtMs) as { count: number }
      ).count,
    );
    const replaySuccessCount = Number(
      (
        this.database.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM stream_health_events WHERE provider=? AND type='REPLAY_COMPLETED' AND wall_timestamp_ms>=?",
          )
          .get(this.providers.primary, outageStartedAtMs) as { count: number }
      ).count,
    );
    const duplicateEvents = Number(
      (
        this.database.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM live_validation_events WHERE is_duplicate=1 AND created_at_ms>=?",
          )
          .get(outageStartedAtMs) as { count: number }
      ).count,
    );
    const eventsDuringOutage = secondarySignatures.length;
    const lostEvents = Math.max(0, eventsDuringOutage - recovered);
    const status =
      eventsDuringOutage === 0
        ? "INCONCLUSIVE"
        : lostEvents === 0
          ? "PASS"
          : "FAIL";
    const result: RecoveryValidationResult = {
      id,
      scenario,
      eventsDuringOutage,
      recoveredEvents: recovered,
      lostEvents,
      duplicateEvents,
      replayCount,
      replaySuccessCount,
      status,
    };
    await this.store.finishRecoveryRun(id, {
      ...result,
      details: { outageStartedAtMs, outageEndedAtMs },
    });
    return result;
  }
}
