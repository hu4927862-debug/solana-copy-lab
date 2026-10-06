import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Logger } from "pino";
import type { SqliteDatabase } from "../persistence/database.js";
import { readFollowerExitStatuses } from "../persistence/follower-exit-status.js";

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return 0;
    throw error;
  }
}

interface WalCheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

export class SoakMonitor {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly logger: Logger,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sample().catch((error: unknown) =>
        this.logger.error({ error }, "soak_metric_sample_failed"),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  async sample(): Promise<void> {
    const exits = readFollowerExitStatuses(this.database);
    const blocked = exits.filter(
      (exit) => exit.status === "SOURCE_FULL_EXIT_WITH_FOLLOWER_REMAINDER",
    );
    if (blocked.length)
      this.logger.warn(
        {
          blockedExitPositions: blocked.map((exit) => ({
            ...exit,
            remainingTokenRaw: exit.remainingTokenRaw.toString(),
            remainingCostQuoteRaw: exit.remainingCostQuoteRaw.toString(),
          })),
        },
        "follower_exit_requires_attention",
      );
    const [dbSizeBytes, walSizeBytes] = await Promise.all([
      fileSize(this.database.path),
      fileSize(`${this.database.path}-wal`),
    ]);
    const health = this.database.getWriterHealth();
    await this.database.write(() => {
      const started = performance.now();
      const checkpointRows = this.database.sqlite.pragma(
        "wal_checkpoint(PASSIVE)",
        {
          simple: false,
        },
      ) as WalCheckpointRow[];
      const checkpoint = checkpointRows[0];
      const checkpointDurationMs = performance.now() - started;
      this.database.sqlite
        .prepare(
          `INSERT INTO soak_metrics
           (sampled_at_ms, db_size_bytes, wal_size_bytes, writer_queue_size,
            writer_pending, busy_error_count, write_latency_average_ms,
            write_latency_p95_ms, wal_checkpoint_duration_ms, wal_checkpoint_busy,
            wal_checkpoint_log_frames, wal_checkpointed_frames)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Date.now(),
          dbSizeBytes,
          walSizeBytes,
          health.queueSize,
          health.pending,
          health.busyErrorCount,
          health.averageMs,
          health.p95Ms,
          checkpointDurationMs,
          checkpoint?.busy ?? null,
          checkpoint?.log ?? null,
          checkpoint?.checkpointed ?? null,
        );
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sample();
  }
}
