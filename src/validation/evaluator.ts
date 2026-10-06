import type { SqliteDatabase } from "../persistence/database.js";
import { distribution, type Distribution } from "./statistics.js";
import type { ValidationClassification } from "./types.js";

interface ValidationRow {
  id: string;
  signature: string;
  leader: string;
  program_ids_json: string;
  system_classification: ValidationClassification;
  ground_truth_classification: ValidationClassification;
  ground_truth_source: "AUTO_RULE" | "HUMAN_REVIEW";
  dex: string | null;
  token_mint: string | null;
  quote_mint: string | null;
  balance_deltas_json: string;
  classifier_evidence_json: string;
  skip_reason: string | null;
  capture_path: string;
  decode_error: string | null;
  is_duplicate: number;
}

export interface AccuracyMetrics {
  readonly observed: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly trueNegative: number;
  readonly unsupported: number;
  readonly ambiguous: number;
  readonly duplicate: number;
  readonly decodeError: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly groundTruth: {
    readonly humanReviewed: number;
    readonly provisionalAutoRule: number;
  };
}

export interface LiveEvaluatorOptions {
  readonly providerComparisonAvailable?: boolean;
}

const DEX_NAMES = ["JUPITER", "RAYDIUM", "PUMP_FUN", "PUMP_SWAP"] as const;

function isSwap(value: ValidationClassification): boolean {
  return value === "BUY" || value === "SELL";
}

function accuracy(rows: readonly ValidationRow[]): AccuracyMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const row of rows) {
    const systemSwap = isSwap(row.system_classification);
    const truthSwap = isSwap(row.ground_truth_classification);
    if (
      systemSwap &&
      truthSwap &&
      row.system_classification === row.ground_truth_classification
    )
      truePositive += 1;
    else if (systemSwap && !truthSwap) falsePositive += 1;
    else if (!systemSwap && truthSwap) falseNegative += 1;
    else if (systemSwap && truthSwap) {
      falsePositive += 1;
      falseNegative += 1;
    } else if (
      row.system_classification !== "UNKNOWN" &&
      row.system_classification !== "UNSUPPORTED" &&
      row.ground_truth_classification !== "UNKNOWN" &&
      row.ground_truth_classification !== "UNSUPPORTED"
    ) {
      trueNegative += 1;
    }
  }
  const precision =
    truePositive + falsePositive === 0
      ? null
      : truePositive / (truePositive + falsePositive);
  const recall =
    truePositive + falseNegative === 0
      ? null
      : truePositive / (truePositive + falseNegative);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return {
    observed: rows.length,
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    unsupported: rows.filter(
      (row) => row.system_classification === "UNSUPPORTED",
    ).length,
    ambiguous: rows.filter((row) => row.system_classification === "UNKNOWN")
      .length,
    duplicate: rows.filter((row) => row.is_duplicate === 1).length,
    decodeError: rows.filter((row) => row.decode_error !== null).length,
    precision,
    recall,
    f1,
    groundTruth: {
      humanReviewed: rows.filter(
        (row) => row.ground_truth_source === "HUMAN_REVIEW",
      ).length,
      provisionalAutoRule: rows.filter(
        (row) => row.ground_truth_source === "AUTO_RULE",
      ).length,
    },
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { parseError: true, raw: value };
  }
}

function falseNegativeCategory(row: ValidationRow): string {
  if (
    isSwap(row.system_classification) &&
    isSwap(row.ground_truth_classification)
  )
    return "balance mismatch";
  const reason =
    `${row.skip_reason ?? ""} ${row.decode_error ?? ""}`.toLowerCase();
  if (reason.includes("unknown_swap_program")) return "unsupported program";
  if (reason.includes("asset_delta") || reason.includes("direction"))
    return "balance mismatch";
  if (reason.includes("ownership")) return "owner ambiguity";
  if (reason.includes("quote")) return "quote ambiguity";
  if (reason.includes("token_2022") || reason.includes("token-2022"))
    return "Token-2022";
  if (reason.includes("multi") || reason.includes("multiple non-quote"))
    return "multi-swap";
  if (row.decode_error) return "parser failure";
  return "unknown";
}

export class LiveEvaluator {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: LiveEvaluatorOptions = {},
  ) {}

  accuracy(): {
    readonly overall: AccuracyMetrics;
    readonly byDex: Readonly<Record<string, AccuracyMetrics>>;
  } {
    const rows = this.validationRows();
    return {
      overall: accuracy(rows),
      byDex: Object.fromEntries(
        DEX_NAMES.map((dex) => [
          dex,
          accuracy(rows.filter((row) => row.dex === dex)),
        ]),
      ),
    };
  }

  falsePositives(): readonly unknown[] {
    return this.validationRows()
      .filter(
        (row) =>
          isSwap(row.system_classification) &&
          row.system_classification !== row.ground_truth_classification,
      )
      .map((row) => ({
        signature: row.signature,
        program: parseJson(row.program_ids_json),
        balanceDelta: parseJson(row.balance_deltas_json),
        classifierEvidence: parseJson(row.classifier_evidence_json),
        reason: `SYSTEM_${row.system_classification}_GROUND_TRUTH_${row.ground_truth_classification}`,
        dex: row.dex,
        token: row.token_mint,
        leader: row.leader,
        capturePath: row.capture_path,
      }));
  }

  falseNegatives(): readonly unknown[] {
    return this.validationRows()
      .filter(
        (row) =>
          isSwap(row.ground_truth_classification) &&
          row.system_classification !== row.ground_truth_classification,
      )
      .map((row) => ({
        signature: row.signature,
        category: falseNegativeCategory(row),
        systemClassification: row.system_classification,
        groundTruthClassification: row.ground_truth_classification,
        skipReason: row.skip_reason,
        dex: row.dex,
        token: row.token_mint,
        leader: row.leader,
        classifierEvidence: parseJson(row.classifier_evidence_json),
        capturePath: row.capture_path,
      }));
  }

  providerLatency(): unknown {
    if (this.options.providerComparisonAvailable !== true) {
      return {
        status: "NOT_AVAILABLE_SINGLE_PROVIDER",
        arrivalDeltaMs: distribution([]),
        disconnectCount: 0,
        reconnectDurationMs: distribution([]),
        missingEvents: {},
        replayCount: 0,
        replaySuccessCount: 0,
      };
    }
    const rows = this.database.sqlite
      .prepare(
        "SELECT arrival_delta_ms AS value FROM provider_event_comparisons WHERE status='MATCHED' AND arrival_delta_ms IS NOT NULL",
      )
      .all() as Array<{ value: number }>;
    const missing = this.database.sqlite
      .prepare(
        "SELECT status, COUNT(*) AS count FROM provider_event_comparisons WHERE status != 'MATCHED' GROUP BY status",
      )
      .all() as Array<{ status: string; count: number }>;
    const health = this.database.sqlite
      .prepare(
        "SELECT type, duration_ms AS durationMs, details_json AS detailsJson FROM stream_health_events",
      )
      .all() as Array<{
      type: string;
      durationMs: number | null;
      detailsJson: string;
    }>;
    const replayEvents = health.filter(
      (event) => event.type === "REPLAY_COMPLETED",
    );
    return {
      status: "AVAILABLE_DUAL_PROVIDER",
      arrivalDeltaMs: distribution(rows.map((row) => row.value)),
      disconnectCount: health.filter((event) => event.type === "DISCONNECTED")
        .length,
      reconnectDurationMs: distribution(
        health
          .filter(
            (event) =>
              event.type === "RECONNECTED" && event.durationMs !== null,
          )
          .map((event) => event.durationMs!),
      ),
      missingEvents: Object.fromEntries(
        missing.map((item) => [item.status, item.count]),
      ),
      replayCount: replayEvents.reduce((sum, event) => {
        const details = parseJson(event.detailsJson) as {
          replayCount?: unknown;
        };
        return (
          sum +
          (typeof details.replayCount === "number" ? details.replayCount : 0)
        );
      }, 0),
      replaySuccessCount: replayEvents.length,
    };
  }

  latency(): Readonly<Record<string, Distribution>> {
    const rows = this.database.sqlite
      .prepare(
        `SELECT stream_to_decode_ms, decode_to_decision_ms, decision_to_jupiter_request_ms,
                jupiter_rtt_ms, full_shadow_pipeline_ms FROM live_latency_samples`,
      )
      .all() as Array<Record<string, number | null>>;
    const values = (column: string) =>
      rows.flatMap((row) => (row[column] === null ? [] : [row[column]!]));
    return {
      streamToDecodeMs: distribution(values("stream_to_decode_ms")),
      decodeToDecisionMs: distribution(values("decode_to_decision_ms")),
      decisionToJupiterRequestMs: distribution(
        values("decision_to_jupiter_request_ms"),
      ),
      jupiterRttMs: distribution(values("jupiter_rtt_ms")),
      fullShadowPipelineMs: distribution(values("full_shadow_pipeline_ms")),
    };
  }

  jupiterLatency(): unknown {
    const rows = this.database.sqlite
      .prepare(
        "SELECT rtt_ms AS rttMs, http_status AS httpStatus, schema_valid AS schemaValid, failure_reason AS failureReason FROM jupiter_shadow_quotes",
      )
      .all() as Array<{
      rttMs: number | null;
      httpStatus: number | null;
      schemaValid: number;
      failureReason: string | null;
    }>;
    return {
      rttMs: distribution(
        rows.flatMap((row) => (row.rttMs === null ? [] : [row.rttMs])),
      ),
      requestCount: rows.length,
      schemaValidCount: rows.filter((row) => row.schemaValid === 1).length,
      failureCount: rows.filter((row) => row.failureReason !== null).length,
      httpStatus: Object.fromEntries(
        [...new Set(rows.map((row) => row.httpStatus ?? "NO_RESPONSE"))].map(
          (status) => [
            String(status),
            rows.filter((row) => (row.httpStatus ?? "NO_RESPONSE") === status)
              .length,
          ],
        ),
      ),
    };
  }

  theoreticalPerformance(): unknown {
    const rows = this.database.sqlite
      .prepare(
        `SELECT dex, token_mint AS token, leader, observed_hour AS hour, provider,
                CAST(theoretical_price_difference_pct AS REAL) AS difference,
                CAST(adverse_price_difference_pct AS REAL) AS adverse
         FROM jupiter_shadow_quotes WHERE theoretical_price_difference_pct IS NOT NULL`,
      )
      .all() as Array<Record<string, string | number | null>>;
    const aggregate = (key: "dex" | "token" | "leader" | "hour" | "provider") =>
      Object.fromEntries(
        [...new Set(rows.map((row) => String(row[key] ?? "UNKNOWN")))].map(
          (value) => {
            const group = rows.filter(
              (row) => String(row[key] ?? "UNKNOWN") === value,
            );
            return [
              value,
              {
                priceDifferencePct: distribution(
                  group.map((row) => Number(row.difference)),
                ),
                adversePriceDifferencePct: distribution(
                  group.map((row) => Number(row.adverse)),
                ),
              },
            ];
          },
        ),
      );
    return {
      byDex: aggregate("dex"),
      byToken: aggregate("token"),
      byLeader: aggregate("leader"),
      byHour: aggregate("hour"),
      byProvider: aggregate("provider"),
    };
  }

  soak(): unknown {
    const latest = this.database.sqlite
      .prepare("SELECT * FROM soak_metrics ORDER BY sampled_at_ms DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    const maxima = this.database.sqlite
      .prepare(
        `SELECT MAX(db_size_bytes) AS maxDbSizeBytes, MAX(wal_size_bytes) AS maxWalSizeBytes,
                MAX(writer_queue_size) AS maxWriterQueueSize, MAX(writer_pending) AS maxWriterPending,
                MAX(busy_error_count) AS busyErrorCount, MAX(write_latency_p95_ms) AS maxWriteLatencyP95Ms
         FROM soak_metrics`,
      )
      .get() as Record<string, unknown>;
    return { latest: latest ?? null, maxima };
  }

  recovery(): readonly unknown[] {
    return this.database.sqlite
      .prepare("SELECT * FROM recovery_validation_runs ORDER BY started_at_ms")
      .all() as readonly unknown[];
  }

  counts(): unknown {
    const rows = this.validationRows();
    return {
      totalObservedTransactions: rows.length,
      totalSupportedSwaps: rows.filter((row) =>
        isSwap(row.system_classification),
      ).length,
      buyCount: rows.filter((row) => row.system_classification === "BUY")
        .length,
      sellCount: rows.filter((row) => row.system_classification === "SELL")
        .length,
      unsupportedCount: rows.filter(
        (row) => row.system_classification === "UNSUPPORTED",
      ).length,
      ambiguousCount: rows.filter(
        (row) => row.system_classification === "UNKNOWN",
      ).length,
      falsePositiveCount: this.falsePositives().length,
      falseNegativeCount: this.falseNegatives().length,
      lostEventCount: Number(
        (
          this.database.sqlite
            .prepare(
              "SELECT COALESCE(SUM(lost_events), 0) AS value FROM recovery_validation_runs",
            )
            .get() as { value: number }
        ).value,
      ),
      duplicateEventCount: rows.filter((row) => row.is_duplicate === 1).length,
    };
  }

  private validationRows(): ValidationRow[] {
    return this.database.sqlite
      .prepare("SELECT * FROM live_validation_events ORDER BY created_at_ms")
      .all() as ValidationRow[];
  }
}
