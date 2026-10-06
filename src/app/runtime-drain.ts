import type { SqliteDatabase } from "../persistence/database.js";

interface DrainCounts {
  readonly queueDepth: number;
  readonly recoveryPending: number;
  readonly transportPending: number;
}
export interface RuntimeDrainSnapshot extends DrainCounts {
  readonly writer: ReturnType<SqliteDatabase["getWriterHealth"]>;
  readonly streamPending: number;
  readonly pendingDeliveries: readonly {
    provider: string;
    subscriptionKey: string;
    signature: string;
    slot: string;
  }[];
  readonly drainedAtMs: number;
  readonly disposition: "DRAINED" | "INCOMPLETE";
  readonly stageFailures: readonly string[];
}

export async function drainRuntime(options: {
  database: SqliteDatabase;
  timeoutMs?: number;
  stages: readonly { name: string; run(): Promise<unknown> }[];
  counts(): DrainCounts;
  record(snapshot: RuntimeDrainSnapshot): void;
}): Promise<RuntimeDrainSnapshot> {
  const stageFailures: string[] = [];
  const deadline = performance.now() + (options.timeoutMs ?? Infinity);
  for (const stage of options.stages) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("DRAIN_STAGE_TIMEOUT");
      const operation = stage.run();
      if (!Number.isFinite(remaining)) await operation;
      else
        await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("DRAIN_STAGE_TIMEOUT")),
              remaining,
            );
          }),
        ]);
    } catch {
      stageFailures.push(stage.name);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const pendingDeliveries = options.database.sqlite
    .prepare(
      "SELECT provider, subscription_key AS subscriptionKey, signature, slot FROM stream_pending_deliveries ORDER BY provider, subscription_key, length(slot), slot, signature",
    )
    .all() as RuntimeDrainSnapshot["pendingDeliveries"];
  const streamPending = pendingDeliveries.length;
  const counts = options.counts();
  const writer = options.database.getWriterHealth();
  const incomplete = Boolean(
    stageFailures.length ||
    counts.queueDepth ||
    counts.recoveryPending ||
    counts.transportPending ||
    writer.pending ||
    writer.queueSize ||
    streamPending,
  );
  const snapshot: RuntimeDrainSnapshot = {
    ...counts,
    writer,
    streamPending,
    pendingDeliveries,
    drainedAtMs: Date.now(),
    disposition: incomplete ? "INCOMPLETE" : "DRAINED",
    stageFailures,
  };
  options.record(snapshot);
  if (incomplete) throw new Error("CANARY_DRAIN_INCOMPLETE");
  return snapshot;
}
