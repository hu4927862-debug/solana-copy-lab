import { createHash } from "node:crypto";
import { stableId } from "../domain/ids.js";
import { jsonStringify } from "../domain/json.js";
import type { ExecutionRealismDelayPolicy } from "../research/execution-realism-policy.js";
import type { SqliteDatabase } from "./database.js";

export interface FirstQuoteResearchParent {
  readonly executionKey: string;
  readonly validationEventId: string;
  readonly referenceTimestampMs: number;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountRaw: bigint;
  readonly firstQuoteOutputAmountRaw: bigint;
}

export type DelayedQuoteFailureCode =
  | "HTTP_ERROR"
  | "SCHEMA_INVALID"
  | "TIMEOUT"
  | "REQUEST_FAILED"
  | "UNEXPECTED_ERROR";

export interface DelayedQuoteEvidence {
  readonly parentExecutionKey: string;
  readonly validationEventId: string;
  readonly policyVersion: ExecutionRealismDelayPolicy["policyVersion"];
  readonly referenceTimestampMs: number;
  readonly intendedDelayMs: number;
  readonly actualRequestTimestampMs: number;
  readonly actualResponseTimestampMs: number | null;
  readonly actualObservedDelayMs: number;
  readonly requestMonotonicNs: bigint | null;
  readonly responseMonotonicNs: bigint | null;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountRaw: bigint;
  readonly returnedInputAmountRaw: bigint | null;
  readonly returnedInputAmountStatus: "AVAILABLE" | "UNAVAILABLE";
  readonly returnedOutputAmountRaw: bigint | null;
  readonly jupiterRequestId: string | null;
  readonly swapMode: string | null;
  readonly httpStatus: number | null;
  readonly schemaValid: boolean;
  readonly router: string | null;
  readonly route: readonly unknown[] | null;
  readonly routeStatus: "AVAILABLE" | "UNAVAILABLE";
  readonly priceImpactPct: string | null;
  readonly outcome: "SUCCESS" | "FAILURE";
  readonly failureCode: DelayedQuoteFailureCode | null;
  readonly failureDetail: string | null;
}

export interface DelayedQuoteEvidenceRow extends Omit<
  DelayedQuoteEvidence,
  | "inputAmountRaw"
  | "returnedInputAmountRaw"
  | "returnedOutputAmountRaw"
  | "requestMonotonicNs"
  | "responseMonotonicNs"
> {
  readonly evidenceId: string;
  readonly inputAmountRaw: string;
  readonly returnedInputAmountRaw: string | null;
  readonly returnedOutputAmountRaw: string | null;
  readonly requestMonotonicNs: string | null;
  readonly responseMonotonicNs: string | null;
  readonly sourceFingerprint: string;
  readonly createdAtMs: number;
}

export type DelayedQuoteAppendResult = "INSERTED" | "DUPLICATE";

export interface DelayedQuoteEvidenceSink {
  has(
    parentExecutionKey: string,
    policyVersion: string,
    intendedDelayMs: number,
  ): boolean;
  append(evidence: DelayedQuoteEvidence): Promise<DelayedQuoteAppendResult>;
}

export interface OutputDecayComparison {
  readonly intendedDelayMs: number;
  readonly status: "AVAILABLE" | "UNAVAILABLE";
  readonly firstQuoteOutputAmountRaw: string;
  readonly delayedQuoteOutputAmountRaw: string | null;
  readonly relativeOutputDecay: {
    readonly numeratorRaw: string;
    readonly denominatorRaw: string;
  } | null;
  readonly availabilityReason:
    "FORWARD_EVIDENCE_NOT_CAPTURED" | "DELAYED_QUOTE_FAILED" | null;
}

function fingerprint(evidence: DelayedQuoteEvidence): string {
  const canonical = {
    actualObservedDelayMs: evidence.actualObservedDelayMs,
    actualRequestTimestampMs: evidence.actualRequestTimestampMs,
    actualResponseTimestampMs: evidence.actualResponseTimestampMs,
    failureCode: evidence.failureCode,
    failureDetail: evidence.failureDetail,
    httpStatus: evidence.httpStatus,
    inputAmountRaw: evidence.inputAmountRaw.toString(),
    inputMint: evidence.inputMint,
    intendedDelayMs: evidence.intendedDelayMs,
    jupiterRequestId: evidence.jupiterRequestId,
    outcome: evidence.outcome,
    outputMint: evidence.outputMint,
    parentExecutionKey: evidence.parentExecutionKey,
    policyVersion: evidence.policyVersion,
    priceImpactPct: evidence.priceImpactPct,
    referenceTimestampMs: evidence.referenceTimestampMs,
    requestMonotonicNs: evidence.requestMonotonicNs?.toString() ?? null,
    responseMonotonicNs: evidence.responseMonotonicNs?.toString() ?? null,
    returnedInputAmountRaw: evidence.returnedInputAmountRaw?.toString() ?? null,
    returnedInputAmountStatus: evidence.returnedInputAmountStatus,
    returnedOutputAmountRaw:
      evidence.returnedOutputAmountRaw?.toString() ?? null,
    route: evidence.route,
    routeStatus: evidence.routeStatus,
    router: evidence.router,
    schemaValid: evidence.schemaValid,
    swapMode: evidence.swapMode,
    validationEventId: evidence.validationEventId,
  };
  return createHash("sha256").update(jsonStringify(canonical)).digest("hex");
}

export class ExecutionRealismEvidenceStore implements DelayedQuoteEvidenceSink {
  constructor(private readonly database: SqliteDatabase) {}

  has(
    parentExecutionKey: string,
    policyVersion: string,
    intendedDelayMs: number,
  ): boolean {
    return (
      this.database.sqlite
        .prepare(
          `SELECT 1 FROM execution_realism_delayed_quotes
           WHERE parent_execution_key = ? AND policy_version = ? AND intended_delay_ms = ?`,
        )
        .get(parentExecutionKey, policyVersion, intendedDelayMs) !== undefined
    );
  }

  async append(
    evidence: DelayedQuoteEvidence,
  ): Promise<DelayedQuoteAppendResult> {
    const sourceFingerprint = fingerprint(evidence);
    const evidenceId = stableId(
      "execution_realism",
      evidence.parentExecutionKey,
      evidence.policyVersion,
      evidence.intendedDelayMs,
    );
    return this.database.write(() => {
      const result = this.database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO execution_realism_delayed_quotes(
             evidence_id, parent_execution_key, validation_event_id, policy_version,
             reference_timestamp_ms, intended_delay_ms, actual_request_timestamp_ms,
             actual_response_timestamp_ms, actual_observed_delay_ms,
             request_monotonic_ns, response_monotonic_ns, input_mint, output_mint,
             input_amount_raw, returned_input_amount_raw, returned_output_amount_raw,
             returned_input_amount_status, jupiter_request_id, swap_mode, http_status,
             schema_valid, router, route_json, route_status, price_impact_pct,
             outcome, failure_code, failure_detail, source_fingerprint, created_at_ms
           ) VALUES (${Array.from({ length: 30 }, () => "?").join(", ")})`,
        )
        .run(
          evidenceId,
          evidence.parentExecutionKey,
          evidence.validationEventId,
          evidence.policyVersion,
          evidence.referenceTimestampMs,
          evidence.intendedDelayMs,
          evidence.actualRequestTimestampMs,
          evidence.actualResponseTimestampMs,
          evidence.actualObservedDelayMs,
          evidence.requestMonotonicNs?.toString() ?? null,
          evidence.responseMonotonicNs?.toString() ?? null,
          evidence.inputMint,
          evidence.outputMint,
          evidence.inputAmountRaw.toString(),
          evidence.returnedInputAmountRaw?.toString() ?? null,
          evidence.returnedOutputAmountRaw?.toString() ?? null,
          evidence.returnedInputAmountStatus,
          evidence.jupiterRequestId,
          evidence.swapMode,
          evidence.httpStatus,
          evidence.schemaValid ? 1 : 0,
          evidence.router,
          evidence.route === null ? null : jsonStringify(evidence.route),
          evidence.routeStatus,
          evidence.priceImpactPct,
          evidence.outcome,
          evidence.failureCode,
          evidence.failureDetail,
          sourceFingerprint,
          evidence.actualResponseTimestampMs ??
            evidence.actualRequestTimestampMs,
        );
      return result.changes === 1 ? "INSERTED" : "DUPLICATE";
    });
  }

  list(parentExecutionKey: string): readonly DelayedQuoteEvidenceRow[] {
    const rows = this.database.sqlite
      .prepare(
        `SELECT * FROM execution_realism_delayed_quotes
         WHERE parent_execution_key = ? ORDER BY intended_delay_ms`,
      )
      .all(parentExecutionKey) as Record<string, unknown>[];
    return rows.map((row) => ({
      evidenceId: String(row.evidence_id),
      parentExecutionKey: String(row.parent_execution_key),
      validationEventId: String(row.validation_event_id),
      policyVersion:
        row.policy_version as DelayedQuoteEvidenceRow["policyVersion"],
      referenceTimestampMs: Number(row.reference_timestamp_ms),
      intendedDelayMs: Number(row.intended_delay_ms),
      actualRequestTimestampMs: Number(row.actual_request_timestamp_ms),
      actualResponseTimestampMs:
        row.actual_response_timestamp_ms === null
          ? null
          : Number(row.actual_response_timestamp_ms),
      actualObservedDelayMs: Number(row.actual_observed_delay_ms),
      requestMonotonicNs:
        row.request_monotonic_ns === null
          ? null
          : String(row.request_monotonic_ns),
      responseMonotonicNs:
        row.response_monotonic_ns === null
          ? null
          : String(row.response_monotonic_ns),
      inputMint: String(row.input_mint),
      outputMint: String(row.output_mint),
      inputAmountRaw: String(row.input_amount_raw),
      returnedInputAmountRaw:
        row.returned_input_amount_raw === null
          ? null
          : String(row.returned_input_amount_raw),
      returnedInputAmountStatus:
        row.returned_input_amount_status as DelayedQuoteEvidenceRow["returnedInputAmountStatus"],
      returnedOutputAmountRaw:
        row.returned_output_amount_raw === null
          ? null
          : String(row.returned_output_amount_raw),
      jupiterRequestId:
        row.jupiter_request_id === null ? null : String(row.jupiter_request_id),
      swapMode: row.swap_mode === null ? null : String(row.swap_mode),
      httpStatus: row.http_status === null ? null : Number(row.http_status),
      schemaValid: Number(row.schema_valid) === 1,
      router: row.router === null ? null : String(row.router),
      route:
        row.route_json === null
          ? null
          : (JSON.parse(String(row.route_json)) as readonly unknown[]),
      routeStatus: row.route_status as DelayedQuoteEvidenceRow["routeStatus"],
      priceImpactPct:
        row.price_impact_pct === null ? null : String(row.price_impact_pct),
      outcome: row.outcome as DelayedQuoteEvidenceRow["outcome"],
      failureCode: row.failure_code as DelayedQuoteEvidenceRow["failureCode"],
      failureDetail:
        row.failure_detail === null ? null : String(row.failure_detail),
      sourceFingerprint: String(row.source_fingerprint),
      createdAtMs: Number(row.created_at_ms),
    }));
  }

  compare(
    parent: FirstQuoteResearchParent,
    intendedOffsetsMs: readonly number[] = [3_000, 10_000],
  ): readonly OutputDecayComparison[] {
    const rows = new Map(
      this.list(parent.executionKey).map((row) => [row.intendedDelayMs, row]),
    );
    return intendedOffsetsMs.map((intendedDelayMs) => {
      const row = rows.get(intendedDelayMs);
      if (row === undefined) {
        return {
          intendedDelayMs,
          status: "UNAVAILABLE" as const,
          firstQuoteOutputAmountRaw:
            parent.firstQuoteOutputAmountRaw.toString(),
          delayedQuoteOutputAmountRaw: null,
          relativeOutputDecay: null,
          availabilityReason: "FORWARD_EVIDENCE_NOT_CAPTURED" as const,
        };
      }
      const delayed = row.returnedOutputAmountRaw;
      if (
        row.outcome !== "SUCCESS" ||
        delayed === null ||
        BigInt(delayed) <= 0n ||
        parent.firstQuoteOutputAmountRaw <= 0n
      ) {
        return {
          intendedDelayMs: row.intendedDelayMs,
          status: "UNAVAILABLE" as const,
          firstQuoteOutputAmountRaw:
            parent.firstQuoteOutputAmountRaw.toString(),
          delayedQuoteOutputAmountRaw: null,
          relativeOutputDecay: null,
          availabilityReason: "DELAYED_QUOTE_FAILED" as const,
        };
      }
      return {
        intendedDelayMs: row.intendedDelayMs,
        status: "AVAILABLE" as const,
        firstQuoteOutputAmountRaw: parent.firstQuoteOutputAmountRaw.toString(),
        delayedQuoteOutputAmountRaw: delayed,
        relativeOutputDecay: {
          numeratorRaw: (
            parent.firstQuoteOutputAmountRaw - BigInt(delayed)
          ).toString(),
          denominatorRaw: parent.firstQuoteOutputAmountRaw.toString(),
        },
        availabilityReason: null,
      };
    });
  }
}
