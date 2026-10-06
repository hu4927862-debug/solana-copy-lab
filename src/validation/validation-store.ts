import PQueue from "p-queue";
import type { Logger } from "pino";
import { jsonStringify } from "../domain/json.js";
import type { StreamTransactionEnvelope } from "../domain/ports.js";
import type { Clock } from "../domain/time.js";
import type { SqliteDatabase } from "../persistence/database.js";
import type {
  StreamHealthNotification,
  StreamHealthObserver,
} from "../stream/stream-health.js";
import type {
  JupiterQuoteTelemetry,
  LivePipelineStages,
  ValidationClassification,
  ValidationRecord,
} from "./types.js";

function elapsedMs(start?: bigint, end?: bigint): number | null {
  if (start === undefined || end === undefined || end < start) return null;
  return Number(end - start) / 1_000_000;
}

export interface RecoveryRunResult {
  readonly eventsDuringOutage: number;
  readonly recoveredEvents: number;
  readonly lostEvents: number;
  readonly duplicateEvents: number;
  readonly replayCount: number;
  readonly replaySuccessCount: number;
  readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly details?: Readonly<Record<string, unknown>>;
}

export class ValidationStore implements StreamHealthObserver {
  private readonly receiptQueue = new PQueue({ concurrency: 1 });

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: Clock,
    private readonly providers: {
      readonly primary: string;
      readonly secondary?: string;
    },
    private readonly logger?: Logger,
  ) {}

  enqueueProviderReceipt(
    provider: string,
    envelope: StreamTransactionEnvelope,
    isReplay = false,
  ): void {
    void this.receiptQueue
      .add(() => this.recordProviderReceipt(provider, envelope, isReplay))
      .catch((error: unknown) =>
        this.logger?.error(
          { error, provider },
          "provider_receipt_write_failed",
        ),
      );
  }

  async recordProviderReceipt(
    provider: string,
    envelope: StreamTransactionEnvelope,
    isReplay = false,
  ): Promise<void> {
    const now = this.clock.now();
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO provider_receipts
           (signature, provider, slot, received_timestamp_ms, received_monotonic_ns, is_replay, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.signature,
          provider,
          envelope.slot.toString(),
          envelope.streamReceivedTimestampMs,
          envelope.streamReceivedMonotonicNs.toString(),
          isReplay ? 1 : 0,
          now.wallMs,
        );
      this.compareProviders(envelope.signature, now.wallMs);
    });
  }

  notify(event: StreamHealthNotification): void {
    void this.database
      .write(() => {
        const insert = this.database.sqlite.prepare(
          `INSERT INTO stream_health_events
             (provider, type, duration_ms, details_json, wall_timestamp_ms, monotonic_timestamp_ns)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        insert.run(
          event.provider,
          event.type,
          event.durationMs ?? null,
          jsonStringify(event.details ?? {}),
          event.wallTimestampMs,
          event.monotonicTimestampNs.toString(),
        );
        if (event.type === "DISCONNECTED") {
          insert.run(
            event.provider,
            "DEGRADED",
            null,
            jsonStringify({ sourceType: event.type }),
            event.wallTimestampMs,
            event.monotonicTimestampNs.toString(),
          );
        }
      })
      .catch((error: unknown) =>
        this.logger?.error({ error, event }, "stream_health_write_failed"),
      );
  }

  async markMissingProviderEvents(graceBeforeMs: number): Promise<void> {
    const secondary = this.providers.secondary;
    if (!secondary) return;
    const now = this.clock.now().wallMs;
    await this.database.write(() => {
      const receipts = this.database.sqlite
        .prepare(
          `SELECT signature, provider, received_timestamp_ms AS receivedTimestampMs
           FROM provider_receipts
           WHERE received_timestamp_ms <= ? AND provider IN (?, ?)`,
        )
        .all(graceBeforeMs, this.providers.primary, secondary) as Array<{
        signature: string;
        provider: string;
        receivedTimestampMs: number;
      }>;
      const grouped = new Map<string, Map<string, number>>();
      for (const receipt of receipts) {
        const group =
          grouped.get(receipt.signature) ?? new Map<string, number>();
        group.set(receipt.provider, receipt.receivedTimestampMs);
        grouped.set(receipt.signature, group);
      }
      const statement = this.database.sqlite.prepare(
        `INSERT INTO provider_event_comparisons
         (signature, primary_provider, secondary_provider, primary_received_timestamp_ms,
          secondary_received_timestamp_ms, arrival_delta_ms, status, compared_at_ms)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(signature) DO UPDATE SET
           primary_received_timestamp_ms=excluded.primary_received_timestamp_ms,
           secondary_received_timestamp_ms=excluded.secondary_received_timestamp_ms,
           status=excluded.status,
           compared_at_ms=excluded.compared_at_ms`,
      );
      for (const [signature, group] of grouped) {
        if (group.size === 2) continue;
        const primaryTimestamp = group.get(this.providers.primary) ?? null;
        const secondaryTimestamp = group.get(secondary) ?? null;
        statement.run(
          signature,
          this.providers.primary,
          secondary,
          primaryTimestamp,
          secondaryTimestamp,
          primaryTimestamp === null ? "PRIMARY_MISSING" : "SECONDARY_MISSING",
          now,
        );
      }
    });
  }

  async saveValidation(record: ValidationRecord): Promise<boolean> {
    return this.database.write(() => {
      const result = this.database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO live_validation_events
           (id, signature, event_index, slot, block_time_ms, leader, primary_provider,
            program_ids_json, system_classification, ground_truth_classification,
            ground_truth_source, dex, token_mint, quote_mint, balance_deltas_json,
            classifier_evidence_json, skip_reason, capture_path, decode_error,
            is_duplicate, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.signature,
          record.eventIndex,
          record.slot.toString(),
          record.blockTimeMs ?? null,
          record.leader,
          record.primaryProvider,
          jsonStringify(record.programIds),
          record.systemClassification,
          record.groundTruth.classification,
          record.groundTruth.source,
          record.dex ?? null,
          record.tokenMint ?? null,
          record.quoteMint ?? null,
          jsonStringify(record.balanceDeltas),
          jsonStringify(record.classifierEvidence),
          record.skipReason ?? null,
          record.capturePath,
          record.decodeError ?? null,
          record.isDuplicate ? 1 : 0,
          record.createdAtMs,
        );
      const needsReview =
        record.groundTruth.reviewReason !== undefined ||
        record.systemClassification === "UNKNOWN" ||
        record.systemClassification === "UNSUPPORTED" ||
        record.groundTruth.classification !== record.systemClassification;
      if (needsReview) {
        this.database.sqlite
          .prepare(
            `INSERT OR IGNORE INTO review_queue
             (validation_event_id, reason, status, proposed_classification, created_at_ms)
             VALUES (?, ?, 'PENDING', ?, ?)`,
          )
          .run(
            record.id,
            record.groundTruth.reviewReason ?? "CLASSIFIER_CONFLICT",
            record.groundTruth.classification,
            record.createdAtMs,
          );
      }
      return result.changes === 1;
    });
  }

  async saveLatency(
    eventId: string,
    stages: LivePipelineStages,
  ): Promise<void> {
    const createdAtMs = this.clock.now().wallMs;
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          `INSERT INTO live_latency_samples
           (validation_event_id, stream_received_monotonic_ns, detected_monotonic_ns,
            normalized_monotonic_ns, classified_monotonic_ns,
            copy_intent_created_monotonic_ns, jupiter_request_started_monotonic_ns,
            jupiter_response_received_monotonic_ns, shadow_execution_completed_monotonic_ns,
            stream_to_decode_ms, decode_to_decision_ms, decision_to_jupiter_request_ms,
            jupiter_rtt_ms, full_shadow_pipeline_ms, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(validation_event_id) DO UPDATE SET
             detected_monotonic_ns=excluded.detected_monotonic_ns,
             normalized_monotonic_ns=excluded.normalized_monotonic_ns,
             classified_monotonic_ns=excluded.classified_monotonic_ns,
             copy_intent_created_monotonic_ns=excluded.copy_intent_created_monotonic_ns,
             jupiter_request_started_monotonic_ns=excluded.jupiter_request_started_monotonic_ns,
             jupiter_response_received_monotonic_ns=excluded.jupiter_response_received_monotonic_ns,
             shadow_execution_completed_monotonic_ns=excluded.shadow_execution_completed_monotonic_ns,
             stream_to_decode_ms=excluded.stream_to_decode_ms,
             decode_to_decision_ms=excluded.decode_to_decision_ms,
             decision_to_jupiter_request_ms=excluded.decision_to_jupiter_request_ms,
             jupiter_rtt_ms=excluded.jupiter_rtt_ms,
             full_shadow_pipeline_ms=excluded.full_shadow_pipeline_ms`,
        )
        .run(
          eventId,
          stages.streamReceivedMonotonicNs.toString(),
          stages.detectedMonotonicNs?.toString() ?? null,
          stages.normalizedMonotonicNs?.toString() ?? null,
          stages.classifiedMonotonicNs?.toString() ?? null,
          stages.copyIntentCreatedMonotonicNs?.toString() ?? null,
          stages.jupiterRequestStartedMonotonicNs?.toString() ?? null,
          stages.jupiterResponseReceivedMonotonicNs?.toString() ?? null,
          stages.shadowExecutionCompletedMonotonicNs?.toString() ?? null,
          elapsedMs(
            stages.streamReceivedMonotonicNs,
            stages.normalizedMonotonicNs,
          ),
          elapsedMs(stages.normalizedMonotonicNs, stages.classifiedMonotonicNs),
          elapsedMs(
            stages.classifiedMonotonicNs,
            stages.jupiterRequestStartedMonotonicNs,
          ),
          elapsedMs(
            stages.jupiterRequestStartedMonotonicNs,
            stages.jupiterResponseReceivedMonotonicNs,
          ),
          elapsedMs(
            stages.streamReceivedMonotonicNs,
            stages.shadowExecutionCompletedMonotonicNs,
          ),
          createdAtMs,
        );
    });
  }

  async saveJupiterQuote(quote: JupiterQuoteTelemetry): Promise<void> {
    const rttMs = elapsedMs(
      quote.requestMonotonicNs,
      quote.responseMonotonicNs,
    );
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          `INSERT OR REPLACE INTO jupiter_shadow_quotes
           (validation_event_id, execution_key, request_timestamp_ms, response_timestamp_ms,
            request_monotonic_ns, response_monotonic_ns, http_status, schema_valid,
            input_mint, output_mint, input_raw, expected_output_raw, router, route_json,
            price_impact_pct, quote_age_ms, rtt_ms, source_price, expected_execution_price,
            theoretical_price_difference_pct, adverse_price_difference_pct, provider,
            dex, token_mint, leader, observed_hour, failure_reason, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          quote.validationEventId,
          quote.executionKey,
          quote.requestTimestampMs,
          quote.responseTimestampMs ?? null,
          quote.requestMonotonicNs.toString(),
          quote.responseMonotonicNs?.toString() ?? null,
          quote.httpStatus ?? null,
          quote.schemaValid ? 1 : 0,
          quote.inputMint,
          quote.outputMint,
          quote.inputRaw.toString(),
          quote.expectedOutputRaw?.toString() ?? null,
          quote.router ?? null,
          jsonStringify(quote.route ?? []),
          quote.priceImpactPct ?? null,
          quote.quoteAgeMs ?? null,
          rttMs,
          quote.sourcePrice ?? null,
          quote.expectedExecutionPrice ?? null,
          quote.theoreticalPriceDifferencePct ?? null,
          quote.adversePriceDifferencePct ?? null,
          quote.provider ?? null,
          quote.dex ?? null,
          quote.tokenMint ?? null,
          quote.leader ?? null,
          quote.observedHour ?? null,
          quote.failureReason ?? null,
          quote.responseTimestampMs ?? quote.requestTimestampMs,
        );
    });
  }

  async updateQuoteAge(
    executionKey: string,
    quoteAgeMs: number,
  ): Promise<void> {
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          "UPDATE jupiter_shadow_quotes SET quote_age_ms=? WHERE execution_key=?",
        )
        .run(quoteAgeMs, executionKey);
    });
  }

  async review(
    eventId: string,
    classification: ValidationClassification,
    notes?: string,
  ): Promise<void> {
    const now = this.clock.now().wallMs;
    await this.database.write(() => {
      this.database.sqlite.transaction(() => {
        this.database.sqlite
          .prepare(
            `UPDATE live_validation_events
             SET ground_truth_classification=?, ground_truth_source='HUMAN_REVIEW', reviewed_at_ms=?
             WHERE id=?`,
          )
          .run(classification, now, eventId);
        this.database.sqlite
          .prepare(
            `UPDATE review_queue SET status='REVIEWED', human_classification=?, notes=?, reviewed_at_ms=?
             WHERE validation_event_id=?`,
          )
          .run(classification, notes ?? null, now, eventId);
      })();
    });
  }

  async beginRecoveryRun(
    id: string,
    scenario: "STREAM_15S_DISCONNECT" | "KILL_9_RESTART" | "PRIMARY_DOWN",
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          `INSERT INTO recovery_validation_runs
           (id, scenario, started_at_ms, status, details_json)
           VALUES (?, ?, ?, 'RUNNING', ?)`,
        )
        .run(id, scenario, this.clock.now().wallMs, jsonStringify(details));
    });
  }

  async finishRecoveryRun(
    id: string,
    result: RecoveryRunResult,
  ): Promise<void> {
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          `UPDATE recovery_validation_runs SET completed_at_ms=?, events_during_outage=?,
           recovered_events=?, lost_events=?, duplicate_events=?, replay_count=?,
           replay_success_count=?, status=?, details_json=? WHERE id=?`,
        )
        .run(
          this.clock.now().wallMs,
          result.eventsDuringOutage,
          result.recoveredEvents,
          result.lostEvents,
          result.duplicateEvents,
          result.replayCount,
          result.replaySuccessCount,
          result.status,
          jsonStringify(result.details ?? {}),
          id,
        );
    });
  }

  async drain(): Promise<void> {
    await this.receiptQueue.onIdle();
    await this.database.writer.onIdle();
  }

  private compareProviders(signature: string, comparedAtMs: number): void {
    const secondary = this.providers.secondary;
    if (!secondary) return;
    const rows = this.database.sqlite
      .prepare(
        `SELECT provider, received_timestamp_ms AS receivedTimestampMs,
                received_monotonic_ns AS receivedMonotonicNs
         FROM provider_receipts WHERE signature=? AND provider IN (?, ?)`,
      )
      .all(signature, this.providers.primary, secondary) as Array<{
      provider: string;
      receivedTimestampMs: number;
      receivedMonotonicNs: string;
    }>;
    if (rows.length !== 2) return;
    const primary = rows.find((row) => row.provider === this.providers.primary);
    const passive = rows.find((row) => row.provider === secondary);
    if (!primary || !passive) return;
    const deltaMs =
      Number(
        BigInt(passive.receivedMonotonicNs) -
          BigInt(primary.receivedMonotonicNs),
      ) / 1_000_000;
    this.database.sqlite
      .prepare(
        `INSERT INTO provider_event_comparisons
         (signature, primary_provider, secondary_provider, primary_received_timestamp_ms,
          secondary_received_timestamp_ms, arrival_delta_ms, status, compared_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'MATCHED', ?)
         ON CONFLICT(signature) DO UPDATE SET
           primary_received_timestamp_ms=excluded.primary_received_timestamp_ms,
           secondary_received_timestamp_ms=excluded.secondary_received_timestamp_ms,
           arrival_delta_ms=excluded.arrival_delta_ms,
           status='MATCHED', compared_at_ms=excluded.compared_at_ms`,
      )
      .run(
        signature,
        this.providers.primary,
        secondary,
        primary.receivedTimestampMs,
        passive.receivedTimestampMs,
        deltaMs,
        comparedAtMs,
      );
  }
}
