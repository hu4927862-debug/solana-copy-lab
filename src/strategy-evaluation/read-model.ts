import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalDomainQuoteMint } from "../domain/assets.js";
import type { ExecutionMode, ExecutionState } from "../domain/execution.js";
import type {
  SourceTimestampProvenance,
  TimestampPrecision,
} from "../domain/time.js";
import type { TradeSide } from "../domain/trades.js";
import { SqliteDatabase } from "../persistence/database.js";
import type {
  RiskDecision,
  RiskDecisionKind,
  RiskReasonCode,
} from "../risk/risk-engine.js";
import type { ValidationClassification } from "../validation/types.js";
import {
  projectNormalizedPreRiskSizingEvidence,
  type CopyabilityBucket,
  type CopyabilityEvaluationContext,
  type NormalizedPreRiskSizingEvidence,
} from "./copyability.js";
import type {
  FollowerScopedJupiterAttemptEvidence,
  PaperFillApplicationOutcomeEvidence,
  PaperFillOutcomeEvidence,
} from "./execution-quality.js";
import type { NormalizedOpportunityEvidence } from "./failure-taxonomy.js";
import type {
  DetailedFollowerFillApplicationEvidence,
  FollowerFillApplicationEvidence,
} from "./round-trips.js";

const REQUIRED_SCHEMA_MIGRATIONS = [
  {
    version: "0001_initial.sql",
    checksum:
      "0953a0ebcc527af57ed69ee263a6a93740897e4e6d68ef166fbfd7a7e9588f4e",
  },
  {
    version: "0002_live_shadow_validation.sql",
    checksum:
      "21d9ed8d8537082150d7e67a962560d969c44e159d4bdfe0680d3c0748ab0da9",
  },
  {
    version: "0003_paper_trading_v1.sql",
    checksum:
      "fe9d65c2a2f7e05fa10815830b663cc3ccd598f22627d21ecc2ed351ba985e59",
  },
  {
    version: "0004_risk_engine_v1.sql",
    checksum:
      "00e9c9cb43dee0ce821e642479b7272bbdfe77bba01e7df5d87c3961e33c2f2b",
  },
  {
    version: "0005_risk_commitment_scope.sql",
    checksum:
      "3d1a0732972cabb10381cc63b96a4eb05459f83a8e7cc757d77192631f6f72d4",
  },
  {
    version: "0006_risk_authorization_hardening.sql",
    checksum:
      "632d6209e12b96b9a3561f5390bdb1e02d22054624acb9abe2b1efd383f9a5b3",
  },
  {
    version: "0007_leader_research_evidence.sql",
    checksum:
      "eef6e254a47ecdb7b1da09dd4e123781b45abbd51618e4871e7527e1f0adfcd8",
  },
  {
    version: "0008_execution_realism_delayed_quotes.sql",
    checksum:
      "cb151be0dfe413964b72772587d4b58e1d463391e110e5cf717808a26e668bd0",
  },
  {
    version: "0009_paper_fee_evidence_contract_v1.sql",
    checksum:
      "25e0e605f13f32800c2c96b3dad70c141ac204759dea3bf92050b6c8ae313eeb",
  },
  {
    version: "0010_stream_pending_deliveries.sql",
    checksum:
      "96de4d15bde63246a7e82654848038014ceb7c830015c80787dd24a322eaa25d",
  },
  {
    version: "0011_automatic_exit_recovery.sql",
    checksum: "588720e851a1b560a0e867eaf2411b03036d13bbcde9d63ca23ec82865b20368",
  },
] as const;

export interface StrategyEvaluationReadSnapshotRequest {
  readonly databasePath: string;
  readonly window: StrategyEvaluationReadWindow;
  readonly expectedContext: CopyabilityEvaluationContext;
  readonly shadowPaperEvidenceBinding?: ShadowPaperEvidenceBinding;
}

/**
 * Explicit provenance that permits a SHADOW observation posture to supply
 * follower Paper economic evidence. This does not change the persisted intent
 * mode and is deliberately fixed to the approved V1 execution definitions.
 */
export interface ShadowPaperEvidenceBinding {
  readonly definitionVersion: "SHADOW_PAPER_EVIDENCE_BINDING_V1";
  readonly observationPosture: "SHADOW";
  readonly economicMode: "PAPER";
  readonly paperOnly: true;
  readonly liveFundsEnabled: false;
  readonly riskPolicyVersion: "PAPER_RISK_V1";
  readonly fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1";
  readonly accountingPolicyVersion: "WEIGHTED_AVERAGE_V1";
  readonly copyabilityDefinitionVersion: "COPYABILITY_V1";
  readonly historicalEvaluationDefinitionVersion: "HISTORICAL_EVALUATION_V3";
  readonly roundTripDefinitionVersion: "FOLLOWER_ROUND_TRIPS_V2";
  readonly strategyMetricDefinitionVersion: "STRATEGY_METRICS_V1";
}

export interface StrategyEvaluationReadWindow {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

export interface StrategyEvaluationEvidenceSnapshot {
  readonly provenance: StrategyEvaluationSnapshotProvenance;
  /**
   * Lifecycle replay evidence for the accepted cohort's position buckets.
   * It may include applications before the requested window start to preserve
   * continuity, but never includes an application whose authoritative leader
   * source timestamp is at or after the requested window end.
   */
  readonly roundTripApplications: readonly FollowerFillApplicationEvidence[];
  readonly roundTripApplicationSources: readonly RoundTripApplicationSourceEvidence[];
  readonly paperFills: readonly PaperFillOutcomeEvidence[];
  readonly paperFillApplications: readonly PaperFillApplicationOutcomeEvidence[];
  readonly jupiterAttempts: readonly FollowerScopedJupiterAttemptEvidence[];
  readonly riskDecisions: readonly RiskDecision[];
  readonly opportunities: readonly StrategyEvaluationOpportunityProjection[];
  readonly observationExclusions: readonly ObservationOnlyEvidence[];
  readonly observationLimitations: readonly ObservationOnlyEvidence[];
  readonly contextLimitations: readonly StrategyEvaluationReadLimitation[];
}

export interface StrategyEvaluationReadSnapshot extends Omit<
  StrategyEvaluationEvidenceSnapshot,
  "roundTripApplications"
> {
  readonly roundTripApplications: readonly DetailedFollowerFillApplicationEvidence[];
}

export interface StrategyEvaluationSnapshotProvenance {
  readonly resolvedDatabasePath: string;
  readonly observedSchemaMigrations: readonly ObservedSchemaMigration[];
  readonly requestedWindow: StrategyEvaluationReadWindow;
  readonly expectedContext: CopyabilityEvaluationContext;
  readonly shadowPaperEvidenceBinding?: ShadowPaperEvidenceBinding;
}

export interface ObservedSchemaMigration {
  readonly version: string;
  readonly checksum: string;
}

export type StrategyEvaluationReadLimitationReason =
  | "WINDOW_MEMBERSHIP_UNPROVEN"
  | "CONTEXT_COPY_RATIO_MISMATCH"
  | "CONTEXT_MODE_UNAVAILABLE"
  | "CONTEXT_MODE_MISMATCH"
  | "CONTEXT_RISK_POLICY_CONFLICT"
  | "CONTEXT_RISK_POLICY_MISMATCH"
  | "CONTEXT_FILL_POLICY_MISMATCH"
  | "CONTEXT_ACCOUNTING_POLICY_UNAVAILABLE"
  | "CONTEXT_ACCOUNTING_POLICY_MISMATCH";

export interface BucketScopedStrategyEvaluationReadLimitation extends CopyabilityBucket {
  readonly executionKey: string;
  readonly reason: StrategyEvaluationReadLimitationReason;
  readonly expected?: string | number;
  readonly observed?: string | number | null;
}

export interface ObservationScopedStrategyEvaluationReadLimitation {
  readonly observationId: string;
  readonly reason: "WINDOW_MEMBERSHIP_UNPROVEN";
}

export type StrategyEvaluationReadLimitation =
  | BucketScopedStrategyEvaluationReadLimitation
  | ObservationScopedStrategyEvaluationReadLimitation;

export interface OpportunitySourceTimestampEvidence {
  readonly valueMs: number | null;
  readonly precision: TimestampPrecision;
  readonly provenance: SourceTimestampProvenance;
}

export interface RoundTripApplicationSourceEvidence {
  readonly fillId: string;
  readonly executionKey: string;
  readonly leaderTradeId: string;
  readonly sourceTimestamp: OpportunitySourceTimestampEvidence;
}

export interface OpportunityObservationEvidence {
  readonly id: string;
  readonly signature: string;
  readonly eventIndex: number;
  readonly leaderWallet: string;
  readonly systemClassification: ValidationClassification;
  readonly groundTruthClassification: ValidationClassification;
  readonly structuredReasonCode: string | null;
  readonly isDuplicate: boolean;
}

export interface ObservationOnlyEvidence extends OpportunityObservationEvidence {
  readonly limitationReason?: StrategyEvaluationReadLimitationReason;
}

export interface StrategyEvaluationOpportunityProjection {
  readonly executionKey: string;
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly quoteMint: string;
  readonly side: TradeSide;
  readonly leaderTradeId: string;
  readonly sourceTimestamp: OpportunitySourceTimestampEvidence;
  readonly observation?: OpportunityObservationEvidence;
  readonly normalizedEvidence: NormalizedOpportunityEvidence;
  readonly preRiskSizingEvidence?: NormalizedPreRiskSizingEvidence;
}

interface FillApplicationRow {
  readonly fill_id: string;
  readonly intent_id: string;
  readonly leader_trade_id: string;
  readonly joined_follower_execution_key: string | null;
  readonly joined_follower_leader_trade_id: string | null;
  readonly joined_leader_trade_id: string | null;
  readonly joined_follower_wallet: string | null;
  readonly joined_leader_wallet: string | null;
  readonly joined_follower_side: string | null;
  readonly joined_leader_side: string | null;
  readonly joined_follower_token_mint: string | null;
  readonly joined_leader_token_mint: string | null;
  readonly joined_follower_quote_mint: string | null;
  readonly joined_leader_quote_mint: string | null;
  readonly position_id: number;
  readonly follower_wallet: string;
  readonly leader_wallet: string;
  readonly side: string;
  readonly input_mint: string;
  readonly output_mint: string;
  readonly input_amount_raw: string;
  readonly output_amount_raw: string;
  readonly quote_timestamp_ms: number;
  readonly transition: string;
  readonly quantity_before_raw: string;
  readonly quantity_after_raw: string;
  readonly allocated_cost_basis_raw: string;
  readonly proceeds_raw: string;
  readonly realized_pnl_delta_raw: string;
  readonly position_version_after: number;
  readonly applied_at_ms: number;
  readonly source_timestamp_ms: number | null;
  readonly source_timestamp_precision: string | null;
  readonly source_timestamp_provenance: string | null;
  readonly accounting_position_id: number | null;
  readonly accounting_policy_version: string | null;
  readonly position_follower_wallet: string | null;
  readonly position_leader_wallet: string | null;
  readonly position_token_mint: string | null;
  readonly position_quote_mint: string | null;
}

interface JupiterAttemptRow {
  readonly validation_event_id: string;
  readonly execution_key: string;
  readonly follower_execution_key: string | null;
  readonly leader_trade_id: string | null;
  readonly follower_wallet_id: number | null;
  readonly leader_wallet_id: number | null;
  readonly follower_wallet: string | null;
  readonly leader_wallet: string | null;
  readonly follower_side: string | null;
  readonly leader_side: string | null;
  readonly follower_token_mint: string | null;
  readonly leader_token_mint: string | null;
  readonly follower_quote_mint: string | null;
  readonly leader_quote_mint: string | null;
  readonly input_mint: string;
  readonly output_mint: string;
  readonly http_status: number | null;
  readonly schema_valid: number;
  readonly expected_output_raw: string | null;
  readonly route_json: string | null;
}

interface RiskDecisionRow {
  readonly decision_id: string;
  readonly phase: string;
  readonly intent_id: string;
  readonly risk_leader_trade_id: string | null;
  readonly risk_leader_wallet: string | null;
  readonly risk_follower_wallet: string | null;
  readonly risk_side: string | null;
  readonly risk_token_mint: string | null;
  readonly risk_quote_mint: string | null;
  readonly pre_decision_id: string | null;
  readonly quote_request_id: string | null;
  readonly decision: string;
  readonly requested_amount_raw: string;
  readonly approved_amount_raw: string;
  readonly requested_token_raw: string;
  readonly approved_token_raw: string;
  readonly requested_quote_raw: string;
  readonly approved_quote_raw: string;
  readonly reason_code: string;
  readonly policy_version: string;
  readonly relevant_limit_raw: string | null;
  readonly relevant_evidence_json: string;
  readonly decided_at_ms: number;
  readonly follower_execution_key: string | null;
  readonly follower_leader_trade_id: string | null;
  readonly joined_leader_trade_id: string | null;
  readonly follower_wallet_id: number | null;
  readonly leader_wallet_id: number | null;
  readonly joined_follower_wallet: string | null;
  readonly joined_leader_wallet: string | null;
  readonly follower_side: string | null;
  readonly leader_side: string | null;
  readonly follower_token_mint: string | null;
  readonly leader_token_mint: string | null;
  readonly follower_quote_mint: string | null;
  readonly leader_quote_mint: string | null;
}

interface FollowerOpportunityRow {
  readonly execution_key: string;
  readonly leader_trade_id: string;
  readonly follower_wallet_id: number;
  readonly state: string;
  readonly follower_side: string;
  readonly follower_token_mint: string;
  readonly follower_quote_mint: string;
  readonly skip_reason: string | null;
  readonly copy_ratio_bps: number;
  readonly joined_leader_trade_id: string | null;
  readonly leader_wallet_id: number | null;
  readonly joined_follower_wallet_id: number | null;
  readonly follower_wallet: string | null;
  readonly leader_wallet: string | null;
  readonly signature: string | null;
  readonly event_index: number | null;
  readonly leader_side: string | null;
  readonly leader_token_mint: string | null;
  readonly leader_quote_mint: string | null;
  readonly source_timestamp_ms: number | null;
  readonly source_timestamp_precision: string | null;
  readonly source_timestamp_provenance: string | null;
}

interface ObservationRow {
  readonly id: string;
  readonly signature: string;
  readonly event_index: number;
  readonly leader: string;
  readonly system_classification: string;
  readonly ground_truth_classification: string;
  readonly token_mint: string | null;
  readonly quote_mint: string | null;
  readonly skip_reason: string | null;
  readonly is_duplicate: number;
}

interface OpportunityPaperFillRow {
  readonly id: string;
  readonly intent_id: string;
  readonly leader_trade_id: string;
  readonly leader_tx_signature: string;
  readonly leader_wallet: string;
  readonly follower_wallet: string;
  readonly side: string;
  readonly input_mint: string;
  readonly output_mint: string;
  readonly fee_evidence_status: string;
  readonly fee_evidence_contract_id: string | null;
  readonly fee_bps: number | null;
  readonly fee_mint: string | null;
  readonly fee_amount_raw: string | null;
  readonly provider: string;
  readonly fill_policy_version: string;
}

interface IntentModeRow {
  readonly aggregate_id: string;
  readonly payload_json: string;
}

interface LeaderObservationTimestampRow {
  readonly signature: string;
  readonly event_index: number;
  readonly leader_wallet: string;
  readonly source_timestamp_ms: number | null;
  readonly source_timestamp_precision: string;
  readonly source_timestamp_provenance: string;
}

const RISK_REASON_CODES = new Set<RiskReasonCode>([
  "ALLOW",
  "SINGLE_TRADE_LIMIT",
  "RISK_POLICY_FOR_QUOTE_UNAVAILABLE",
  "GLOBAL_HALT_NEW_RISK",
  "INTENT_TIMESTAMP_UNAVAILABLE",
  "INTENT_TIMESTAMP_PROVENANCE_INVALID",
  "STALE_INTENT",
  "TOKEN_COST_EXPOSURE_LIMIT",
  "PORTFOLIO_COST_EXPOSURE_LIMIT",
  "DAILY_REALIZED_LOSS_LIMIT",
  "PROVIDER_DEGRADED",
  "QUOTE_AMOUNT_MISMATCH",
  "PRICE_IMPACT_TOO_HIGH",
  "PRICE_IMPACT_UNAVAILABLE",
  "STALE_QUOTE",
  "ROUTE_INVALID",
  "SELL_NOT_RISK_REDUCING",
]);

function requireDatabasePath(databasePath: unknown): string {
  if (typeof databasePath !== "string" || databasePath.trim() === "") {
    throw new Error("DATABASE_PATH_REQUIRED");
  }
  const resolvedPath = resolve(databasePath);
  if (!existsSync(resolvedPath)) throw new Error("DATABASE_NOT_FOUND");
  if (!statSync(resolvedPath).isFile()) {
    throw new Error("DATABASE_PATH_NOT_FILE");
  }
  return resolvedPath;
}

function validateWindow(window: StrategyEvaluationReadWindow): void {
  if (
    !Number.isFinite(window.windowStartMs) ||
    !Number.isSafeInteger(window.windowStartMs) ||
    !Number.isFinite(window.windowEndMs) ||
    !Number.isSafeInteger(window.windowEndMs) ||
    window.windowStartMs >= window.windowEndMs
  ) {
    throw new Error("INVALID_EVALUATION_WINDOW");
  }
}

function validateExpectedContext(
  context: CopyabilityEvaluationContext,
  window: StrategyEvaluationReadWindow,
): void {
  if (
    !Number.isFinite(context.window.fromMs) ||
    !Number.isSafeInteger(context.window.fromMs) ||
    !Number.isFinite(context.window.toMs) ||
    !Number.isSafeInteger(context.window.toMs) ||
    context.window.fromMs !== window.windowStartMs ||
    context.window.toMs !== window.windowEndMs
  ) {
    throw new Error("EXPECTED_CONTEXT_WINDOW_MISMATCH");
  }
  if (
    (context.mode !== "PAPER" && context.mode !== "SHADOW") ||
    !Number.isSafeInteger(context.copyRatioBps) ||
    context.copyRatioBps < 0 ||
    context.copyRatioBps > 100_000 ||
    [
      context.source,
      context.riskPolicyVersion,
      context.fillPolicyVersion,
      context.accountingPolicyVersion,
      context.copyabilityDefinitionVersion,
    ].some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error("INVALID_EXPECTED_EVALUATION_CONTEXT");
  }
}

const APPROVED_SHADOW_PAPER_EVIDENCE_BINDING = {
  definitionVersion: "SHADOW_PAPER_EVIDENCE_BINDING_V1",
  observationPosture: "SHADOW",
  economicMode: "PAPER",
  paperOnly: true,
  liveFundsEnabled: false,
  riskPolicyVersion: "PAPER_RISK_V1",
  fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
  accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
  copyabilityDefinitionVersion: "COPYABILITY_V1",
  historicalEvaluationDefinitionVersion: "HISTORICAL_EVALUATION_V3",
  roundTripDefinitionVersion: "FOLLOWER_ROUND_TRIPS_V2",
  strategyMetricDefinitionVersion: "STRATEGY_METRICS_V1",
} as const satisfies ShadowPaperEvidenceBinding;

function validateShadowPaperEvidenceBinding(
  binding: ShadowPaperEvidenceBinding | undefined,
): void {
  if (binding === undefined) return;
  for (const [field, expected] of Object.entries(
    APPROVED_SHADOW_PAPER_EVIDENCE_BINDING,
  )) {
    if (binding[field as keyof ShadowPaperEvidenceBinding] !== expected) {
      throw new Error(`INVALID_SHADOW_PAPER_EVIDENCE_BINDING:${field}`);
    }
  }
  if (
    Object.keys(binding).length !==
    Object.keys(APPROVED_SHADOW_PAPER_EVIDENCE_BINDING).length
  ) {
    throw new Error("INVALID_SHADOW_PAPER_EVIDENCE_BINDING:FIELDS");
  }
}

function copyShadowPaperEvidenceBinding(
  binding: ShadowPaperEvidenceBinding,
): ShadowPaperEvidenceBinding {
  return { ...binding };
}

function qualifiesShadowAsPaperEvidence(
  observedMode: ExecutionMode,
  expectedContext: CopyabilityEvaluationContext,
  binding: ShadowPaperEvidenceBinding | undefined,
): boolean {
  return (
    binding !== undefined &&
    observedMode === binding.observationPosture &&
    expectedContext.mode === binding.economicMode &&
    expectedContext.riskPolicyVersion === binding.riskPolicyVersion &&
    expectedContext.fillPolicyVersion === binding.fillPolicyVersion &&
    expectedContext.accountingPolicyVersion ===
      binding.accountingPolicyVersion &&
    expectedContext.copyabilityDefinitionVersion ===
      binding.copyabilityDefinitionVersion
  );
}

function isAuthoritativeSourceTimestamp(
  valueMs: number | null,
  provenance: string | null,
  precision: string | null,
): valueMs is number {
  return (
    valueMs !== null &&
    Number.isSafeInteger(valueMs) &&
    provenance === "CHAIN_BLOCK_TIME" &&
    (precision === "MILLISECOND" || precision === "SECOND")
  );
}

function isAuthoritativeWindowOpportunity(
  row: FollowerOpportunityRow,
  window: StrategyEvaluationReadWindow,
): boolean {
  return (
    isAuthoritativeSourceTimestamp(
      row.source_timestamp_ms,
      row.source_timestamp_provenance ?? "UNKNOWN",
      row.source_timestamp_precision ?? "UNKNOWN",
    ) &&
    row.source_timestamp_ms >= window.windowStartMs &&
    row.source_timestamp_ms < window.windowEndMs
  );
}

function projectIntentModes(
  rows: readonly IntentModeRow[],
): ReadonlyMap<string, ExecutionMode | null> {
  const modes = new Map<string, ExecutionMode | null>();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch {
      throw new Error(`MALFORMED_INTENT_RESERVED_PAYLOAD:${row.aggregate_id}`);
    }
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed !== "object" ||
      !("executionKey" in parsed) ||
      parsed.executionKey !== row.aggregate_id
    ) {
      throw new Error(
        `CONFLICTING_INTENT_RESERVED_IDENTITY:${row.aggregate_id}`,
      );
    }
    const mode =
      "mode" in parsed && (parsed.mode === "PAPER" || parsed.mode === "SHADOW")
        ? parsed.mode
        : null;
    const existing = modes.get(row.aggregate_id);
    if (existing !== undefined && existing !== mode) {
      throw new Error(`CONFLICTING_INTENT_RESERVED_MODE:${row.aggregate_id}`);
    }
    modes.set(row.aggregate_id, mode);
  }
  return modes;
}

function validateSchema(
  database: SqliteDatabase,
): readonly ObservedSchemaMigration[] {
  const observedMigrations = database.sqlite
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as ObservedSchemaMigration[];
  if (
    observedMigrations.length < 8 ||
    observedMigrations.length > REQUIRED_SCHEMA_MIGRATIONS.length ||
    observedMigrations.some(
      ({ version, checksum }, index) =>
        version !== REQUIRED_SCHEMA_MIGRATIONS[index]?.version ||
        checksum !== REQUIRED_SCHEMA_MIGRATIONS[index]?.checksum,
    )
  ) {
    throw new Error("STRATEGY_EVALUATION_SCHEMA_INCOMPATIBLE");
  }
  if (observedMigrations.some(m => m.version === "0011_automatic_exit_recovery.sql") && database.sqlite.prepare("SELECT 1 FROM automatic_exit_policy").get()) {
    throw new Error("AUTOMATIC_EXIT_RECOVERY_REQUIRES_SEPARATE_AUDIT");
  }
  return observedMigrations.map(({ version, checksum }) => ({
    version,
    checksum,
  }));
}

function projectSnapshotProvenance(
  resolvedDatabasePath: string,
  observedSchemaMigrations: readonly ObservedSchemaMigration[],
  window: StrategyEvaluationReadWindow,
  expectedContext: CopyabilityEvaluationContext,
  shadowPaperEvidenceBinding: ShadowPaperEvidenceBinding | undefined,
): StrategyEvaluationSnapshotProvenance {
  return {
    resolvedDatabasePath,
    observedSchemaMigrations: observedSchemaMigrations.map(
      ({ version, checksum }) => ({ version, checksum }),
    ),
    requestedWindow: {
      windowStartMs: window.windowStartMs,
      windowEndMs: window.windowEndMs,
    },
    expectedContext: {
      ...expectedContext,
      window: {
        fromMs: expectedContext.window.fromMs,
        toMs: expectedContext.window.toMs,
      },
    },
    ...(shadowPaperEvidenceBinding === undefined
      ? {}
      : {
          shadowPaperEvidenceBinding: copyShadowPaperEvidenceBinding(
            shadowPaperEvidenceBinding,
          ),
        }),
  };
}

function parseUnsignedRaw(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`MALFORMED_ECONOMIC_RAW:${field}`);
  }
  return BigInt(value);
}

function parseSignedRaw(value: string, field: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`MALFORMED_ECONOMIC_RAW:${field}`);
  }
  return BigInt(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareApplications(
  left: FollowerFillApplicationEvidence,
  right: FollowerFillApplicationEvidence,
): number {
  for (const comparison of [
    compareText(left.followerWallet, right.followerWallet),
    compareText(left.leaderWallet, right.leaderWallet),
    compareText(left.tokenMint, right.tokenMint),
    compareText(left.quoteMint, right.quoteMint),
    left.positionVersionAfter - right.positionVersionAfter,
    left.quoteTimestampMs - right.quoteTimestampMs,
    compareText(left.fillId, right.fillId),
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function comparePaperFills(
  left: PaperFillOutcomeEvidence,
  right: PaperFillOutcomeEvidence,
): number {
  return (
    compareText(left.intentId, right.intentId) || compareText(left.id, right.id)
  );
}

function comparePaperFillApplications(
  left: PaperFillApplicationOutcomeEvidence,
  right: PaperFillApplicationOutcomeEvidence,
): number {
  return (
    left.positionId - right.positionId ||
    left.positionVersionAfter - right.positionVersionAfter ||
    left.appliedAtMs - right.appliedAtMs ||
    compareText(left.fillId, right.fillId)
  );
}

function compareJupiterAttempts(
  left: FollowerScopedJupiterAttemptEvidence,
  right: FollowerScopedJupiterAttemptEvidence,
): number {
  for (const comparison of [
    compareText(left.followerWallet, right.followerWallet),
    compareText(left.leaderWallet, right.leaderWallet),
    compareText(left.quoteMint, right.quoteMint),
    compareText(left.executionKey, right.executionKey),
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareRiskDecisions(left: RiskDecision, right: RiskDecision): number {
  for (const comparison of [
    compareText(left.intentId, right.intentId),
    left.phase === right.phase ? 0 : left.phase === "PRE_QUOTE" ? -1 : 1,
    compareText(left.decisionId, right.decisionId),
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
}

interface OpportunityRootEvidence {
  readonly executionKey: string;
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly quoteMint: string;
  readonly tokenMint: string;
  readonly side: TradeSide;
  readonly leaderTradeId: string;
  readonly leaderSignature: string;
  readonly leaderEventIndex: number;
  readonly sourceTimestamp: OpportunitySourceTimestampEvidence;
  readonly followerTrade: NonNullable<
    NormalizedOpportunityEvidence["followerTrade"]
  >;
  readonly copyRatioBps: number;
}

const EXECUTION_STATES = new Set<ExecutionState>([
  "CREATED",
  "RESERVED",
  "PAPER_EXECUTED",
  "CONFIRMED",
  "SKIPPED",
  "UNCERTAIN",
  "FAILED",
]);

const VALIDATION_CLASSIFICATIONS = new Set<ValidationClassification>([
  "BUY",
  "SELL",
  "TRANSFER",
  "LP",
  "STAKE",
  "LENDING",
  "UNKNOWN",
  "UNSUPPORTED",
]);

const TIMESTAMP_PRECISIONS = new Set<TimestampPrecision>([
  "MILLISECOND",
  "SECOND",
  "SLOT_ONLY",
  "UNKNOWN",
]);

const SOURCE_TIMESTAMP_PROVENANCES = new Set<SourceTimestampProvenance>([
  "CHAIN_BLOCK_TIME",
  "UNKNOWN",
]);

const NON_SWAP_OBSERVATION_CLASSIFICATIONS = new Set<ValidationClassification>([
  "TRANSFER",
  "LP",
  "STAKE",
  "LENDING",
]);

function isTradeSide(value: string): value is TradeSide {
  return value === "BUY" || value === "SELL";
}

function isExecutionState(value: string): value is ExecutionState {
  return EXECUTION_STATES.has(value as ExecutionState);
}

function isValidationClassification(
  value: string,
): value is ValidationClassification {
  return VALIDATION_CLASSIFICATIONS.has(value as ValidationClassification);
}

function isTimestampPrecision(value: string): value is TimestampPrecision {
  return TIMESTAMP_PRECISIONS.has(value as TimestampPrecision);
}

function isSourceTimestampProvenance(
  value: string,
): value is SourceTimestampProvenance {
  return SOURCE_TIMESTAMP_PROVENANCES.has(value as SourceTimestampProvenance);
}

function observationIdentity(
  signature: string,
  leaderWallet: string,
  eventIndex: number,
): string {
  return `${signature}\u0000${leaderWallet}\u0000${eventIndex}`;
}

function paperApplicationPositionIdentity(row: FillApplicationRow): string {
  const { tokenMint, ...scope } = paperApplicationContextScope(row);
  return [
    scope.followerWallet,
    scope.leaderWallet,
    tokenMint,
    scope.quoteMint,
  ].join("\u0000");
}

function paperApplicationContextScope(
  row: FillApplicationRow,
): Pick<
  OpportunityRootEvidence,
  "executionKey" | "followerWallet" | "leaderWallet" | "tokenMint" | "quoteMint"
> {
  const { tokenMint, quoteMint } = validatePaperApplicationIdentity(row);
  validateApplicationPositionIdentity(row, tokenMint, quoteMint);
  return {
    executionKey: row.intent_id,
    followerWallet: row.follower_wallet,
    leaderWallet: row.leader_wallet,
    tokenMint,
    quoteMint,
  };
}

function validatePaperApplicationIdentity(row: FillApplicationRow): {
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly side: TradeSide;
} {
  if (!isTradeSide(row.side)) {
    throw new Error(`INVALID_PAPER_FILL_SIDE:${row.fill_id}`);
  }
  const tokenMint = row.side === "BUY" ? row.output_mint : row.input_mint;
  const quoteMint = row.side === "BUY" ? row.input_mint : row.output_mint;
  if (canonicalDomainQuoteMint(quoteMint) !== quoteMint) {
    throw new Error(`NON_CANONICAL_DOMAIN_QUOTE_MINT:${row.fill_id}`);
  }
  if (
    row.joined_follower_execution_key === null ||
    row.joined_follower_leader_trade_id === null ||
    row.joined_leader_trade_id === null ||
    row.joined_follower_wallet === null ||
    row.joined_leader_wallet === null ||
    row.joined_follower_side === null ||
    row.joined_leader_side === null ||
    row.joined_follower_token_mint === null ||
    row.joined_leader_token_mint === null ||
    row.joined_follower_quote_mint === null ||
    row.joined_leader_quote_mint === null
  ) {
    throw new Error(`MISSING_PAPER_APPLICATION_IDENTITY:${row.fill_id}`);
  }
  if (
    row.intent_id !== row.joined_follower_execution_key ||
    row.leader_trade_id !== row.joined_follower_leader_trade_id ||
    row.leader_trade_id !== row.joined_leader_trade_id ||
    row.follower_wallet !== row.joined_follower_wallet ||
    row.leader_wallet !== row.joined_leader_wallet ||
    row.side !== row.joined_follower_side ||
    row.side !== row.joined_leader_side ||
    tokenMint !== row.joined_follower_token_mint ||
    tokenMint !== row.joined_leader_token_mint ||
    quoteMint !== row.joined_follower_quote_mint ||
    quoteMint !== row.joined_leader_quote_mint
  ) {
    throw new Error(`CONFLICTING_OPPORTUNITY_PAPER_FILL:${row.intent_id}`);
  }
  return { tokenMint, quoteMint, side: row.side };
}

function validateApplicationPositionIdentity(
  row: FillApplicationRow,
  tokenMint: string,
  quoteMint: string,
): void {
  if (
    row.accounting_position_id === null ||
    row.position_follower_wallet === null ||
    row.position_leader_wallet === null ||
    row.position_token_mint === null ||
    row.position_quote_mint === null
  ) {
    throw new Error(`MISSING_APPLICATION_POSITION_IDENTITY:${row.fill_id}`);
  }
  if (
    row.accounting_position_id !== row.position_id ||
    row.position_follower_wallet !== row.follower_wallet ||
    row.position_leader_wallet !== row.leader_wallet ||
    row.position_token_mint !== tokenMint ||
    row.position_quote_mint !== quoteMint
  ) {
    throw new Error(`CONFLICTING_APPLICATION_POSITION_IDENTITY:${row.fill_id}`);
  }
}

function projectOpportunityRoot(
  row: FollowerOpportunityRow,
): OpportunityRootEvidence {
  if (row.joined_leader_trade_id === null) {
    throw new Error(
      `MISSING_LEADER_TRADE_FOR_OPPORTUNITY:${row.execution_key}`,
    );
  }
  if (row.joined_follower_wallet_id === null || row.follower_wallet === null) {
    throw new Error(
      `MISSING_FOLLOWER_WALLET_FOR_OPPORTUNITY:${row.execution_key}`,
    );
  }
  if (row.leader_wallet_id === null || row.leader_wallet === null) {
    throw new Error(
      `MISSING_LEADER_WALLET_FOR_OPPORTUNITY:${row.execution_key}`,
    );
  }
  if (
    row.signature === null ||
    row.event_index === null ||
    row.leader_side === null ||
    row.leader_token_mint === null ||
    row.leader_quote_mint === null ||
    row.source_timestamp_precision === null ||
    row.source_timestamp_provenance === null
  ) {
    throw new Error(
      `INCOMPLETE_LEADER_OPPORTUNITY_EVIDENCE:${row.execution_key}`,
    );
  }
  if (
    row.leader_trade_id !== row.joined_leader_trade_id ||
    row.follower_side !== row.leader_side ||
    row.follower_token_mint !== row.leader_token_mint ||
    row.follower_quote_mint !== row.leader_quote_mint
  ) {
    throw new Error(`CONFLICTING_OPPORTUNITY_IDENTITY:${row.execution_key}`);
  }
  if (!isTradeSide(row.follower_side)) {
    throw new Error(`INVALID_OPPORTUNITY_SIDE:${row.execution_key}`);
  }
  if (!isExecutionState(row.state)) {
    throw new Error(`INVALID_FOLLOWER_TRADE_STATE:${row.execution_key}`);
  }
  if (
    !Number.isSafeInteger(row.event_index) ||
    row.event_index < 0 ||
    !Number.isSafeInteger(row.copy_ratio_bps) ||
    row.copy_ratio_bps < 0 ||
    row.copy_ratio_bps > 100_000 ||
    (row.source_timestamp_ms !== null &&
      !Number.isSafeInteger(row.source_timestamp_ms))
  ) {
    throw new Error(`INVALID_OPPORTUNITY_TIMESTAMP:${row.execution_key}`);
  }
  if (!isTimestampPrecision(row.source_timestamp_precision)) {
    throw new Error(`INVALID_SOURCE_TIMESTAMP_PRECISION:${row.execution_key}`);
  }
  if (!isSourceTimestampProvenance(row.source_timestamp_provenance)) {
    throw new Error(`INVALID_SOURCE_TIMESTAMP_PROVENANCE:${row.execution_key}`);
  }
  if (
    canonicalDomainQuoteMint(row.follower_quote_mint) !==
    row.follower_quote_mint
  ) {
    throw new Error(`NON_CANONICAL_DOMAIN_QUOTE_MINT:${row.execution_key}`);
  }

  return {
    executionKey: row.execution_key,
    followerWallet: row.follower_wallet,
    leaderWallet: row.leader_wallet,
    quoteMint: row.follower_quote_mint,
    tokenMint: row.follower_token_mint,
    side: row.follower_side,
    leaderTradeId: row.leader_trade_id,
    leaderSignature: row.signature,
    leaderEventIndex: row.event_index,
    sourceTimestamp: {
      valueMs: row.source_timestamp_ms,
      precision: row.source_timestamp_precision,
      provenance: row.source_timestamp_provenance,
    },
    followerTrade: {
      executionKey: row.execution_key,
      state: row.state,
      ...(row.skip_reason === null
        ? {}
        : { structuredReasonCode: row.skip_reason }),
    },
    copyRatioBps: row.copy_ratio_bps,
  };
}

function projectObservation(
  row: ObservationRow,
  limitationReason?: StrategyEvaluationReadLimitationReason,
): ObservationOnlyEvidence {
  if (
    !Number.isSafeInteger(row.event_index) ||
    row.event_index < 0 ||
    (row.is_duplicate !== 0 && row.is_duplicate !== 1)
  ) {
    throw new Error(`INVALID_OBSERVATION_EVIDENCE:${row.id}`);
  }
  if (
    !isValidationClassification(row.system_classification) ||
    !isValidationClassification(row.ground_truth_classification)
  ) {
    throw new Error(`INVALID_OBSERVATION_CLASSIFICATION:${row.id}`);
  }
  if (
    row.quote_mint !== null &&
    canonicalDomainQuoteMint(row.quote_mint) !== row.quote_mint
  ) {
    throw new Error(`NON_CANONICAL_DOMAIN_QUOTE_MINT:${row.id}`);
  }
  return {
    id: row.id,
    signature: row.signature,
    eventIndex: row.event_index,
    leaderWallet: row.leader,
    systemClassification: row.system_classification,
    groundTruthClassification: row.ground_truth_classification,
    structuredReasonCode: row.skip_reason,
    isDuplicate: row.is_duplicate === 1,
    ...(limitationReason === undefined ? {} : { limitationReason }),
  };
}

function compareObservationEvidence(
  left: ObservationOnlyEvidence,
  right: ObservationOnlyEvidence,
): number {
  for (const comparison of [
    compareText(left.leaderWallet, right.leaderWallet),
    compareText(left.signature, right.signature),
    left.eventIndex - right.eventIndex,
    compareText(left.id, right.id),
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function resolveObservationWindow(
  observationRows: readonly ObservationRow[],
  leaderRows: readonly LeaderObservationTimestampRow[],
  window: StrategyEvaluationReadWindow,
): {
  readonly rows: ObservationRow[];
  readonly limitationReasons: ReadonlyMap<
    string,
    StrategyEvaluationReadLimitationReason
  >;
  readonly limitations: StrategyEvaluationReadLimitation[];
} {
  const leadersByIdentity = new Map<string, LeaderObservationTimestampRow>();
  for (const row of leaderRows) {
    const identity = observationIdentity(
      row.signature,
      row.leader_wallet,
      row.event_index,
    );
    if (leadersByIdentity.has(identity)) {
      throw new Error(`DUPLICATE_LEADER_OBSERVATION_IDENTITY:${identity}`);
    }
    leadersByIdentity.set(identity, row);
  }

  const rows: ObservationRow[] = [];
  const limitationReasons = new Map<
    string,
    StrategyEvaluationReadLimitationReason
  >();
  const limitations: StrategyEvaluationReadLimitation[] = [];
  for (const row of observationRows) {
    const leader = leadersByIdentity.get(
      observationIdentity(row.signature, row.leader, row.event_index),
    );
    if (
      leader === undefined ||
      !isAuthoritativeSourceTimestamp(
        leader.source_timestamp_ms,
        leader.source_timestamp_provenance,
        leader.source_timestamp_precision,
      )
    ) {
      rows.push(row);
      limitationReasons.set(row.id, "WINDOW_MEMBERSHIP_UNPROVEN");
      limitations.push({
        observationId: row.id,
        reason: "WINDOW_MEMBERSHIP_UNPROVEN",
      });
      continue;
    }
    if (
      leader.source_timestamp_ms >= window.windowStartMs &&
      leader.source_timestamp_ms < window.windowEndMs
    ) {
      rows.push(row);
    }
  }
  return { rows, limitationReasons, limitations };
}

function compareOpportunities(
  left: StrategyEvaluationOpportunityProjection,
  right: StrategyEvaluationOpportunityProjection,
): number {
  const leftTime = left.sourceTimestamp.valueMs;
  const rightTime = right.sourceTimestamp.valueMs;
  const timestampComparison =
    leftTime === rightTime
      ? 0
      : leftTime === null
        ? 1
        : rightTime === null
          ? -1
          : leftTime - rightTime;
  for (const comparison of [
    timestampComparison,
    compareText(left.leaderTradeId, right.leaderTradeId),
    compareText(left.executionKey, right.executionKey),
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function isRiskDecisionKind(value: string): value is RiskDecisionKind {
  return (
    value === "ALLOW" ||
    value === "RESIZE" ||
    value === "REJECT" ||
    value === "HALT"
  );
}

function isRiskReasonCode(value: string): value is RiskReasonCode {
  return RISK_REASON_CODES.has(value as RiskReasonCode);
}

function parseRiskRelevantEvidence(
  value: string,
  decisionId: string,
): Readonly<Record<string, string | number | boolean>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`MALFORMED_RISK_RELEVANT_EVIDENCE:${decisionId}`);
  }
  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.values(parsed).some(
      (item) =>
        typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean",
    )
  ) {
    throw new Error(`MALFORMED_RISK_RELEVANT_EVIDENCE:${decisionId}`);
  }
  return Object.keys(parsed).length === 0
    ? undefined
    : (parsed as Readonly<Record<string, string | number | boolean>>);
}

function projectRiskDecision(row: RiskDecisionRow): RiskDecision {
  if (row.follower_execution_key === null) {
    throw new Error(`MISSING_FOLLOWER_TRADE_FOR_RISK:${row.decision_id}`);
  }
  if (row.joined_leader_trade_id === null) {
    throw new Error(`MISSING_LEADER_TRADE_FOR_RISK:${row.decision_id}`);
  }
  if (row.follower_wallet_id === null || row.joined_follower_wallet === null) {
    throw new Error(`MISSING_FOLLOWER_WALLET_FOR_RISK:${row.decision_id}`);
  }
  if (row.leader_wallet_id === null || row.joined_leader_wallet === null) {
    throw new Error(`MISSING_LEADER_WALLET_FOR_RISK:${row.decision_id}`);
  }
  if (
    row.risk_leader_trade_id === null ||
    row.risk_leader_wallet === null ||
    row.risk_follower_wallet === null ||
    row.risk_side === null ||
    row.risk_token_mint === null ||
    row.risk_quote_mint === null
  ) {
    throw new Error(`MISSING_RISK_IDENTITY_EVIDENCE:${row.decision_id}`);
  }
  if (row.risk_side !== "BUY" && row.risk_side !== "SELL") {
    throw new Error(`INVALID_RISK_SIDE:${row.decision_id}`);
  }
  const riskSide = row.risk_side;
  if (
    row.follower_side === null ||
    row.follower_token_mint === null ||
    row.follower_quote_mint === null ||
    row.risk_leader_trade_id !== row.follower_leader_trade_id ||
    row.risk_leader_trade_id !== row.joined_leader_trade_id ||
    row.risk_leader_wallet !== row.joined_leader_wallet ||
    row.risk_follower_wallet !== row.joined_follower_wallet ||
    row.risk_side !== row.follower_side ||
    row.risk_side !== row.leader_side ||
    row.risk_token_mint !== row.follower_token_mint ||
    row.risk_token_mint !== row.leader_token_mint ||
    row.risk_quote_mint !== row.follower_quote_mint ||
    row.risk_quote_mint !== row.leader_quote_mint
  ) {
    throw new Error(`CONFLICTING_RISK_IDENTITY_EVIDENCE:${row.decision_id}`);
  }
  if (
    canonicalDomainQuoteMint(row.follower_quote_mint) !==
      row.follower_quote_mint ||
    canonicalDomainQuoteMint(row.risk_quote_mint) !== row.risk_quote_mint
  ) {
    throw new Error(`NON_CANONICAL_DOMAIN_QUOTE_MINT:${row.decision_id}`);
  }
  if (row.phase !== "PRE_QUOTE" && row.phase !== "POST_QUOTE") {
    throw new Error(`INVALID_RISK_DECISION_PHASE:${row.decision_id}`);
  }
  if (!isRiskDecisionKind(row.decision)) {
    throw new Error(`INVALID_RISK_DECISION_KIND:${row.decision_id}`);
  }
  if (!isRiskReasonCode(row.reason_code)) {
    throw new Error(
      `UNSUPPORTED_RISK_REASON_CODE:${row.decision_id}:${row.reason_code}`,
    );
  }
  if (!Number.isSafeInteger(row.decided_at_ms)) {
    throw new Error(`INVALID_RISK_DECIDED_AT:${row.decision_id}`);
  }

  const relevantEvidence = parseRiskRelevantEvidence(
    row.relevant_evidence_json,
    row.decision_id,
  );
  const base = {
    decisionId: row.decision_id,
    intentId: row.intent_id,
    leaderTradeId: row.risk_leader_trade_id,
    leaderWallet: row.risk_leader_wallet,
    followerWallet: row.risk_follower_wallet,
    side: riskSide,
    tokenMint: row.risk_token_mint,
    quoteMint: row.risk_quote_mint,
    decision: row.decision,
    requestedAmountRaw: parseUnsignedRaw(
      row.requested_amount_raw,
      "requested_amount_raw",
    ),
    approvedAmountRaw: parseUnsignedRaw(
      row.approved_amount_raw,
      "approved_amount_raw",
    ),
    requestedTokenRaw: parseUnsignedRaw(
      row.requested_token_raw,
      "requested_token_raw",
    ),
    approvedTokenRaw: parseUnsignedRaw(
      row.approved_token_raw,
      "approved_token_raw",
    ),
    requestedQuoteRaw: parseUnsignedRaw(
      row.requested_quote_raw,
      "requested_quote_raw",
    ),
    approvedQuoteRaw: parseUnsignedRaw(
      row.approved_quote_raw,
      "approved_quote_raw",
    ),
    reasonCode: row.reason_code,
    policyVersion: row.policy_version,
    ...(row.relevant_limit_raw === null
      ? {}
      : {
          relevantLimitRaw: parseUnsignedRaw(
            row.relevant_limit_raw,
            "relevant_limit_raw",
          ),
        }),
    ...(relevantEvidence === undefined ? {} : { relevantEvidence }),
    decidedAtMs: row.decided_at_ms,
  } satisfies Omit<RiskDecision, "phase" | "preDecisionId" | "quoteRequestId">;
  if (row.phase === "PRE_QUOTE") {
    if (row.pre_decision_id !== null || row.quote_request_id !== null) {
      throw new Error(`INVALID_PRE_RISK_LINKAGE:${row.decision_id}`);
    }
    return { ...base, phase: "PRE_QUOTE" };
  }
  if (
    row.pre_decision_id === null ||
    row.pre_decision_id === "" ||
    row.quote_request_id === null ||
    row.quote_request_id === ""
  ) {
    throw new Error(`MISSING_POST_RISK_LINKAGE:${row.decision_id}`);
  }
  return {
    ...base,
    phase: "POST_QUOTE",
    preDecisionId: row.pre_decision_id,
    quoteRequestId: row.quote_request_id,
  };
}

function projectRiskDecisions(
  rows: readonly RiskDecisionRow[],
): RiskDecision[] {
  const decisionsByIdentity = new Set<string>();
  const decisions = rows.map((row) => {
    const identity = `${row.phase}\u0000${row.intent_id}`;
    if (decisionsByIdentity.has(identity)) {
      throw new Error(
        `DUPLICATE_RISK_DECISION_EVIDENCE:${row.phase}:${row.intent_id}`,
      );
    }
    decisionsByIdentity.add(identity);
    return projectRiskDecision(row);
  });
  const preDecisionByIntentId = new Map(
    decisions
      .filter((decision) => decision.phase === "PRE_QUOTE")
      .map((decision) => [decision.intentId, decision] as const),
  );
  const preDecisionByDecisionId = new Map(
    decisions
      .filter((decision) => decision.phase === "PRE_QUOTE")
      .map((decision) => [decision.decisionId, decision] as const),
  );
  for (const decision of decisions) {
    if (decision.phase !== "POST_QUOTE") continue;
    const referencedPreDecision = preDecisionByDecisionId.get(
      decision.preDecisionId,
    );
    if (
      referencedPreDecision !== undefined &&
      referencedPreDecision.intentId !== decision.intentId
    ) {
      throw new Error(
        `POST_RISK_PRE_DECISION_CROSS_INTENT:${decision.decisionId}`,
      );
    }
    const preDecision = preDecisionByIntentId.get(decision.intentId);
    if (preDecision === undefined) {
      throw new Error(`POST_RISK_WITHOUT_PRE:${decision.decisionId}`);
    }
    if (decision.preDecisionId !== preDecision.decisionId) {
      throw new Error(`POST_RISK_PRE_DECISION_MISMATCH:${decision.decisionId}`);
    }
  }
  return decisions;
}

function contextLimitation(
  scope: Pick<
    OpportunityRootEvidence,
    "executionKey" | "followerWallet" | "leaderWallet" | "quoteMint"
  >,
  reason: StrategyEvaluationReadLimitationReason,
  expected?: string | number,
  observed?: string | number | null,
): BucketScopedStrategyEvaluationReadLimitation {
  return {
    executionKey: scope.executionKey,
    followerWallet: scope.followerWallet,
    leaderWallet: scope.leaderWallet,
    quoteMint: scope.quoteMint,
    reason,
    ...(expected === undefined ? {} : { expected }),
    ...(observed === undefined ? {} : { observed }),
  };
}

function compareContextLimitations(
  left: StrategyEvaluationReadLimitation,
  right: StrategyEvaluationReadLimitation,
): number {
  const leftExecutionKey = "executionKey" in left ? left.executionKey : "";
  const rightExecutionKey = "executionKey" in right ? right.executionKey : "";
  const leftObservationId = "observationId" in left ? left.observationId : "";
  const rightObservationId =
    "observationId" in right ? right.observationId : "";
  return (
    compareText(leftExecutionKey, rightExecutionKey) ||
    compareText(leftObservationId, rightObservationId) ||
    compareText(left.reason, right.reason)
  );
}

function deduplicateContextLimitations(
  limitations: readonly StrategyEvaluationReadLimitation[],
): readonly StrategyEvaluationReadLimitation[] {
  const limitationByFingerprint = new Map<
    string,
    StrategyEvaluationReadLimitation
  >();
  for (const limitation of limitations) {
    const fingerprint =
      "executionKey" in limitation
        ? JSON.stringify({
            scope: "EXECUTION_BUCKET",
            executionKey: limitation.executionKey,
            followerWallet: limitation.followerWallet,
            leaderWallet: limitation.leaderWallet,
            quoteMint: limitation.quoteMint,
            reason: limitation.reason,
            ...(limitation.expected === undefined
              ? {}
              : { expected: limitation.expected }),
            ...(limitation.observed === undefined
              ? {}
              : { observed: limitation.observed }),
          })
        : JSON.stringify({
            scope: "OBSERVATION",
            observationId: limitation.observationId,
            reason: limitation.reason,
          });
    if (!limitationByFingerprint.has(fingerprint)) {
      limitationByFingerprint.set(fingerprint, limitation);
    }
  }
  return [...limitationByFingerprint.values()].sort(compareContextLimitations);
}

function resolveContextCohort(
  rootRows: readonly FollowerOpportunityRow[],
  modes: ReadonlyMap<string, ExecutionMode | null>,
  riskDecisions: readonly RiskDecision[],
  paperFillRows: readonly OpportunityPaperFillRow[],
  applicationRows: readonly FillApplicationRow[],
  expectedContext: CopyabilityEvaluationContext,
  shadowPaperEvidenceBinding: ShadowPaperEvidenceBinding | undefined,
): {
  readonly acceptedRows: FollowerOpportunityRow[];
  readonly limitations: StrategyEvaluationReadLimitation[];
} {
  const riskByExecutionKey = new Map<string, RiskDecision[]>();
  for (const decision of riskDecisions) {
    const decisions = riskByExecutionKey.get(decision.intentId) ?? [];
    decisions.push(decision);
    riskByExecutionKey.set(decision.intentId, decisions);
  }
  const fillByExecutionKey = new Map(
    paperFillRows.map((fill) => [fill.intent_id, fill] as const),
  );
  const applicationByFillId = new Map(
    applicationRows.map((application) => [application.fill_id, application]),
  );

  const acceptedRows: FollowerOpportunityRow[] = [];
  const limitations: StrategyEvaluationReadLimitation[] = [];
  for (const row of rootRows) {
    const root = projectOpportunityRoot(row);
    const rootLimitations: StrategyEvaluationReadLimitation[] = [];
    if (root.copyRatioBps !== expectedContext.copyRatioBps) {
      rootLimitations.push(
        contextLimitation(
          root,
          "CONTEXT_COPY_RATIO_MISMATCH",
          expectedContext.copyRatioBps,
          root.copyRatioBps,
        ),
      );
    }

    const mode = modes.get(root.executionKey);
    if (mode === undefined || mode === null) {
      rootLimitations.push(contextLimitation(root, "CONTEXT_MODE_UNAVAILABLE"));
    } else if (
      mode !== expectedContext.mode &&
      !qualifiesShadowAsPaperEvidence(
        mode,
        expectedContext,
        shadowPaperEvidenceBinding,
      )
    ) {
      rootLimitations.push(
        contextLimitation(
          root,
          "CONTEXT_MODE_MISMATCH",
          expectedContext.mode,
          mode,
        ),
      );
    }

    const riskVersions = new Set(
      (riskByExecutionKey.get(root.executionKey) ?? []).map(
        (decision) => decision.policyVersion,
      ),
    );
    if (riskVersions.size > 1) {
      rootLimitations.push(
        contextLimitation(
          root,
          "CONTEXT_RISK_POLICY_CONFLICT",
          expectedContext.riskPolicyVersion,
          [...riskVersions].sort().join(","),
        ),
      );
    } else {
      const riskPolicyVersion = [...riskVersions][0];
      if (
        riskPolicyVersion !== undefined &&
        riskPolicyVersion !== expectedContext.riskPolicyVersion
      ) {
        rootLimitations.push(
          contextLimitation(
            root,
            "CONTEXT_RISK_POLICY_MISMATCH",
            expectedContext.riskPolicyVersion,
            riskPolicyVersion,
          ),
        );
      }
    }

    const fill = fillByExecutionKey.get(root.executionKey);
    if (
      fill !== undefined &&
      fill.fill_policy_version !== expectedContext.fillPolicyVersion
    ) {
      rootLimitations.push(
        contextLimitation(
          root,
          "CONTEXT_FILL_POLICY_MISMATCH",
          expectedContext.fillPolicyVersion,
          fill.fill_policy_version,
        ),
      );
    }

    const application =
      fill === undefined ? undefined : applicationByFillId.get(fill.id);
    if (application !== undefined) {
      if (
        application.accounting_position_id === null ||
        application.accounting_policy_version === null
      ) {
        rootLimitations.push(
          contextLimitation(
            root,
            "CONTEXT_ACCOUNTING_POLICY_UNAVAILABLE",
            expectedContext.accountingPolicyVersion,
            application.accounting_policy_version,
          ),
        );
      } else {
        if (
          application.position_follower_wallet !== root.followerWallet ||
          application.position_leader_wallet !== root.leaderWallet ||
          application.position_token_mint !== root.tokenMint ||
          application.position_quote_mint !== root.quoteMint
        ) {
          throw new Error(
            `CONFLICTING_APPLICATION_POSITION_IDENTITY:${application.fill_id}`,
          );
        }
        if (
          application.accounting_policy_version !==
          expectedContext.accountingPolicyVersion
        ) {
          rootLimitations.push(
            contextLimitation(
              root,
              "CONTEXT_ACCOUNTING_POLICY_MISMATCH",
              expectedContext.accountingPolicyVersion,
              application.accounting_policy_version,
            ),
          );
        }
      }
    }

    if (rootLimitations.length === 0) acceptedRows.push(row);
    else limitations.push(...rootLimitations);
  }
  return {
    acceptedRows,
    limitations: limitations.sort(compareContextLimitations),
  };
}

interface OpportunityProjectionResult {
  readonly opportunities: StrategyEvaluationOpportunityProjection[];
  readonly observationExclusions: ObservationOnlyEvidence[];
  readonly observationLimitations: ObservationOnlyEvidence[];
}

function projectOpportunities(
  rootRows: readonly FollowerOpportunityRow[],
  observationRows: readonly ObservationRow[],
  observationWindowLimitations: ReadonlyMap<
    string,
    StrategyEvaluationReadLimitationReason
  >,
  followerObservationIdentities: ReadonlySet<string>,
  jupiterAttempts: readonly FollowerScopedJupiterAttemptEvidence[],
  riskDecisions: readonly RiskDecision[],
  paperFillRows: readonly OpportunityPaperFillRow[],
  applications: readonly FollowerFillApplicationEvidence[],
): OpportunityProjectionResult {
  const rootsByExecutionKey = new Map<string, OpportunityRootEvidence>();
  for (const row of rootRows) {
    if (rootsByExecutionKey.has(row.execution_key)) {
      throw new Error(`DUPLICATE_OPPORTUNITY_ROOT:${row.execution_key}`);
    }
    rootsByExecutionKey.set(row.execution_key, projectOpportunityRoot(row));
  }

  const observationRowsByIdentity = new Map<string, ObservationRow>();
  const observationsById = new Map<string, ObservationRow>();
  for (const row of observationRows) {
    const identity = observationIdentity(
      row.signature,
      row.leader,
      row.event_index,
    );
    if (
      observationRowsByIdentity.has(identity) ||
      observationsById.has(row.id)
    ) {
      throw new Error(`DUPLICATE_OBSERVATION_EVIDENCE:${row.id}`);
    }
    observationRowsByIdentity.set(identity, row);
    observationsById.set(row.id, row);
  }

  const jupiterByExecutionKey = new Map<
    string,
    FollowerScopedJupiterAttemptEvidence[]
  >();
  for (const attempt of jupiterAttempts) {
    const evidence = jupiterByExecutionKey.get(attempt.executionKey) ?? [];
    evidence.push(attempt);
    jupiterByExecutionKey.set(attempt.executionKey, evidence);
  }
  const riskByExecutionKey = new Map<string, RiskDecision[]>();
  for (const decision of riskDecisions) {
    const evidence = riskByExecutionKey.get(decision.intentId) ?? [];
    evidence.push(decision);
    riskByExecutionKey.set(decision.intentId, evidence);
  }

  const paperFillByIntentId = new Map<string, OpportunityPaperFillRow>();
  const paperFillById = new Map<string, OpportunityPaperFillRow>();
  for (const fill of paperFillRows) {
    if (paperFillByIntentId.has(fill.intent_id) || paperFillById.has(fill.id)) {
      throw new Error(`DUPLICATE_PAPER_FILL_EVIDENCE:${fill.intent_id}`);
    }
    paperFillByIntentId.set(fill.intent_id, fill);
    paperFillById.set(fill.id, fill);
    if (!rootsByExecutionKey.has(fill.intent_id)) {
      throw new Error(`PAPER_FILL_WITHOUT_OPPORTUNITY:${fill.id}`);
    }
  }
  const applicationByFillId = new Map<
    string,
    FollowerFillApplicationEvidence
  >();
  for (const application of applications) {
    if (applicationByFillId.has(application.fillId)) {
      throw new Error(`DUPLICATE_PAPER_FILL_APPLICATION:${application.fillId}`);
    }
    applicationByFillId.set(application.fillId, application);
    if (!paperFillById.has(application.fillId)) {
      throw new Error(`ORPHAN_PAPER_FILL_APPLICATION:${application.fillId}`);
    }
  }

  const usedObservationIds = new Set<string>();
  const opportunities = [...rootsByExecutionKey.values()].map((root) => {
    const rootObservationIdentity = observationIdentity(
      root.leaderSignature,
      root.leaderWallet,
      root.leaderEventIndex,
    );
    const observationRow = observationRowsByIdentity.get(
      rootObservationIdentity,
    );
    let observation: OpportunityObservationEvidence | undefined;
    if (observationRow !== undefined) {
      if (
        observationRow.system_classification !== root.side ||
        observationRow.token_mint === null ||
        observationRow.token_mint !== root.tokenMint ||
        observationRow.quote_mint === null ||
        observationRow.quote_mint !== root.quoteMint
      ) {
        throw new Error(
          `CONFLICTING_OPPORTUNITY_OBSERVATION:${root.executionKey}`,
        );
      }
      observation = projectObservation(observationRow);
      usedObservationIds.add(observationRow.id);
    }

    const attempts = jupiterByExecutionKey.get(root.executionKey) ?? [];
    for (const attempt of attempts) {
      if (
        attempt.followerWallet !== root.followerWallet ||
        attempt.leaderWallet !== root.leaderWallet ||
        attempt.quoteMint !== root.quoteMint
      ) {
        throw new Error(
          `CONFLICTING_OPPORTUNITY_JUPITER_IDENTITY:${root.executionKey}`,
        );
      }
      const jupiterObservation = observationsById.get(
        attempt.validationEventId,
      );
      if (
        jupiterObservation === undefined ||
        observationIdentity(
          jupiterObservation.signature,
          jupiterObservation.leader,
          jupiterObservation.event_index,
        ) !== rootObservationIdentity
      ) {
        throw new Error(
          `CONFLICTING_OPPORTUNITY_OBSERVATION:${root.executionKey}`,
        );
      }
    }

    const decisions = riskByExecutionKey.get(root.executionKey) ?? [];
    for (const decision of decisions) {
      if (
        decision.leaderTradeId !== root.leaderTradeId ||
        decision.followerWallet !== root.followerWallet ||
        decision.leaderWallet !== root.leaderWallet ||
        decision.side !== root.side ||
        decision.tokenMint !== root.tokenMint ||
        decision.quoteMint !== root.quoteMint
      ) {
        throw new Error(
          `CONFLICTING_OPPORTUNITY_RISK_IDENTITY:${root.executionKey}`,
        );
      }
    }

    const fill = paperFillByIntentId.get(root.executionKey);
    let application: FollowerFillApplicationEvidence | undefined;
    if (fill !== undefined) {
      const expectedInputMint =
        root.side === "BUY" ? root.quoteMint : root.tokenMint;
      const expectedOutputMint =
        root.side === "BUY" ? root.tokenMint : root.quoteMint;
      if (
        fill.leader_trade_id !== root.leaderTradeId ||
        fill.leader_tx_signature !== root.leaderSignature ||
        fill.leader_wallet !== root.leaderWallet ||
        fill.follower_wallet !== root.followerWallet ||
        fill.side !== root.side ||
        fill.input_mint !== expectedInputMint ||
        fill.output_mint !== expectedOutputMint
      ) {
        throw new Error(
          `CONFLICTING_OPPORTUNITY_PAPER_FILL:${root.executionKey}`,
        );
      }
      application = applicationByFillId.get(fill.id);
      if (
        application !== undefined &&
        (application.followerWallet !== root.followerWallet ||
          application.leaderWallet !== root.leaderWallet ||
          application.side !== root.side ||
          application.tokenMint !== root.tokenMint ||
          application.quoteMint !== root.quoteMint)
      ) {
        throw new Error(
          `CONFLICTING_OPPORTUNITY_PAPER_APPLICATION:${root.executionKey}`,
        );
      }
    }

    const normalizedEvidence: NormalizedOpportunityEvidence = {
      executionKey: root.executionKey,
      ...(observation === undefined
        ? {}
        : {
            observationClassification: observation.systemClassification,
            ...(observation.structuredReasonCode === null
              ? {}
              : observation.structuredReasonCode === "QUOTE_ASSET_NOT_ALLOWED"
                ? {
                    policyExclusionReasonCode: observation.structuredReasonCode,
                  }
                : {
                    observationReasonCode: observation.structuredReasonCode,
                  }),
          }),
      followerTrade: root.followerTrade,
      ...(attempts.length === 0 ? {} : { jupiterAttempts: attempts }),
      ...(decisions.length === 0 ? {} : { riskDecisions: decisions }),
      ...(fill === undefined
        ? {}
        : { paperFill: { id: fill.id, intentId: fill.intent_id } }),
      ...(application === undefined
        ? {}
        : { paperFillApplication: { fillId: application.fillId } }),
    };
    const preRiskSizingEvidence = decisions
      .map(projectNormalizedPreRiskSizingEvidence)
      .find(
        (evidence): evidence is NormalizedPreRiskSizingEvidence =>
          evidence !== undefined,
      );
    return {
      executionKey: root.executionKey,
      followerWallet: root.followerWallet,
      leaderWallet: root.leaderWallet,
      quoteMint: root.quoteMint,
      side: root.side,
      leaderTradeId: root.leaderTradeId,
      sourceTimestamp: root.sourceTimestamp,
      ...(observation === undefined ? {} : { observation }),
      normalizedEvidence,
      ...(preRiskSizingEvidence === undefined ? {} : { preRiskSizingEvidence }),
    } satisfies StrategyEvaluationOpportunityProjection;
  });

  const observationExclusions: ObservationOnlyEvidence[] = [];
  const observationLimitations: ObservationOnlyEvidence[] = [];
  for (const row of observationRows) {
    if (usedObservationIds.has(row.id)) continue;
    if (
      followerObservationIdentities.has(
        observationIdentity(row.signature, row.leader, row.event_index),
      )
    ) {
      continue;
    }
    const evidence = projectObservation(
      row,
      observationWindowLimitations.get(row.id),
    );
    const isLimitation =
      evidence.limitationReason !== undefined ||
      evidence.isDuplicate ||
      evidence.systemClassification === "UNKNOWN" ||
      evidence.systemClassification === "UNSUPPORTED";
    const isExclusion =
      evidence.structuredReasonCode === "QUOTE_ASSET_NOT_ALLOWED" ||
      NON_SWAP_OBSERVATION_CLASSIFICATIONS.has(evidence.systemClassification);
    if (!isLimitation && isExclusion) observationExclusions.push(evidence);
    else observationLimitations.push(evidence);
  }

  return {
    opportunities: opportunities.sort(compareOpportunities),
    observationExclusions: observationExclusions.sort(
      compareObservationEvidence,
    ),
    observationLimitations: observationLimitations.sort(
      compareObservationEvidence,
    ),
  };
}

function parseRoute(
  value: string | null,
  executionKey: string,
): readonly unknown[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`MALFORMED_JUPITER_ROUTE_JSON:${executionKey}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`MALFORMED_JUPITER_ROUTE_JSON:${executionKey}`);
  }
  return parsed;
}

function projectJupiterAttempt(
  row: JupiterAttemptRow,
): FollowerScopedJupiterAttemptEvidence {
  if (row.follower_execution_key === null) {
    throw new Error(`MISSING_FOLLOWER_TRADE_FOR_JUPITER:${row.execution_key}`);
  }
  if (row.leader_trade_id === null) {
    throw new Error(`MISSING_LEADER_TRADE_FOR_JUPITER:${row.execution_key}`);
  }
  if (row.follower_wallet_id === null || row.follower_wallet === null) {
    throw new Error(`MISSING_FOLLOWER_WALLET_FOR_JUPITER:${row.execution_key}`);
  }
  if (row.leader_wallet_id === null || row.leader_wallet === null) {
    throw new Error(`MISSING_LEADER_WALLET_FOR_JUPITER:${row.execution_key}`);
  }
  if (row.follower_side !== "BUY" && row.follower_side !== "SELL") {
    throw new Error(`INVALID_FOLLOWER_TRADE_SIDE:${row.execution_key}`);
  }
  if (
    row.leader_side !== row.follower_side ||
    row.follower_token_mint === null ||
    row.follower_quote_mint === null ||
    row.leader_token_mint !== row.follower_token_mint ||
    row.leader_quote_mint !== row.follower_quote_mint
  ) {
    throw new Error(`CONFLICTING_JUPITER_JOIN_EVIDENCE:${row.execution_key}`);
  }
  if (
    canonicalDomainQuoteMint(row.follower_quote_mint) !==
    row.follower_quote_mint
  ) {
    throw new Error(`NON_CANONICAL_DOMAIN_QUOTE_MINT:${row.execution_key}`);
  }
  const expectedInputMint =
    row.follower_side === "BUY"
      ? row.follower_quote_mint
      : row.follower_token_mint;
  const expectedOutputMint =
    row.follower_side === "BUY"
      ? row.follower_token_mint
      : row.follower_quote_mint;
  if (
    row.input_mint !== expectedInputMint ||
    row.output_mint !== expectedOutputMint
  ) {
    throw new Error(`JUPITER_SIDE_EVIDENCE_MISMATCH:${row.execution_key}`);
  }
  if (row.schema_valid !== 0 && row.schema_valid !== 1) {
    throw new Error(`INVALID_JUPITER_SCHEMA_VALID:${row.execution_key}`);
  }
  if (row.http_status !== null && !Number.isSafeInteger(row.http_status)) {
    throw new Error(`INVALID_JUPITER_HTTP_STATUS:${row.execution_key}`);
  }

  return {
    validationEventId: row.validation_event_id,
    executionKey: row.execution_key,
    followerWallet: row.follower_wallet,
    leaderWallet: row.leader_wallet,
    quoteMint: row.follower_quote_mint,
    httpStatus: row.http_status,
    schemaValid: row.schema_valid === 1,
    expectedOutputRaw:
      row.expected_output_raw === null
        ? null
        : parseUnsignedRaw(row.expected_output_raw, "expected_output_raw"),
    route: parseRoute(row.route_json, row.execution_key),
  };
}

function projectJupiterAttempts(
  rows: readonly JupiterAttemptRow[],
): FollowerScopedJupiterAttemptEvidence[] {
  const executionKeys = new Set<string>();
  return rows.map((row) => {
    if (executionKeys.has(row.execution_key)) {
      throw new Error(
        `DUPLICATE_JUPITER_EXECUTION_EVIDENCE:${row.execution_key}`,
      );
    }
    executionKeys.add(row.execution_key);
    return projectJupiterAttempt(row);
  });
}

function projectApplication(
  row: FillApplicationRow,
): DetailedFollowerFillApplicationEvidence {
  const { tokenMint, quoteMint, side } = validatePaperApplicationIdentity(row);
  if (!Number.isSafeInteger(row.position_id) || row.position_id < 0) {
    throw new Error(`INVALID_POSITION_ID:${row.fill_id}`);
  }
  validateApplicationPositionIdentity(row, tokenMint, quoteMint);
  if (
    row.transition !== "OPEN" &&
    row.transition !== "ADD" &&
    row.transition !== "REDUCE" &&
    row.transition !== "CLOSE"
  ) {
    throw new Error(`INVALID_PAPER_FILL_TRANSITION:${row.fill_id}`);
  }
  if (
    !Number.isSafeInteger(row.position_version_after) ||
    row.position_version_after < 0
  ) {
    throw new Error(`INVALID_POSITION_VERSION:${row.fill_id}`);
  }
  if (!Number.isSafeInteger(row.quote_timestamp_ms)) {
    throw new Error(`INVALID_QUOTE_TIMESTAMP:${row.fill_id}`);
  }

  return {
    fillId: row.fill_id,
    positionId: row.position_id,
    followerWallet: row.follower_wallet,
    leaderWallet: row.leader_wallet,
    tokenMint,
    quoteMint,
    side,
    transition: row.transition,
    inputAmountRaw: parseUnsignedRaw(row.input_amount_raw, "input_amount_raw"),
    outputAmountRaw: parseUnsignedRaw(
      row.output_amount_raw,
      "output_amount_raw",
    ),
    quantityBeforeRaw: parseUnsignedRaw(
      row.quantity_before_raw,
      "quantity_before_raw",
    ),
    quantityAfterRaw: parseUnsignedRaw(
      row.quantity_after_raw,
      "quantity_after_raw",
    ),
    allocatedCostBasisRaw: parseUnsignedRaw(
      row.allocated_cost_basis_raw,
      "allocated_cost_basis_raw",
    ),
    proceedsRaw: parseUnsignedRaw(row.proceeds_raw, "proceeds_raw"),
    realizedPnlDeltaRaw: parseSignedRaw(
      row.realized_pnl_delta_raw,
      "realized_pnl_delta_raw",
    ),
    positionVersionAfter: row.position_version_after,
    quoteTimestampMs: row.quote_timestamp_ms,
  };
}

function projectPaperFill(
  row: OpportunityPaperFillRow,
): PaperFillOutcomeEvidence {
  if (!isTradeSide(row.side)) {
    throw new Error(`INVALID_PAPER_FILL_SIDE:${row.id}`);
  }
  const quoteMint = row.side === "BUY" ? row.input_mint : row.output_mint;
  if (canonicalDomainQuoteMint(quoteMint) !== quoteMint) {
    throw new Error(`NON_CANONICAL_DOMAIN_QUOTE_MINT:${row.id}`);
  }
  if (
    row.fee_evidence_status !== "AVAILABLE" &&
    row.fee_evidence_status !== "AMOUNT_UNAVAILABLE"
  ) {
    throw new Error(`INVALID_FEE_EVIDENCE_STATUS:${row.id}`);
  }
  return {
    id: row.id,
    intentId: row.intent_id,
    leaderWallet: row.leader_wallet,
    followerWallet: row.follower_wallet,
    side: row.side,
    inputMint: row.input_mint,
    outputMint: row.output_mint,
    feeEvidence: {
      status: row.fee_evidence_status,
      ...(row.fee_evidence_contract_id === null
        ? {}
        : { feeEvidenceContractId: row.fee_evidence_contract_id }),
      ...(row.fee_bps === null ? {} : { feeBps: row.fee_bps }),
      ...(row.fee_mint === null ? {} : { feeMint: row.fee_mint }),
      ...(row.fee_amount_raw === null
        ? {}
        : {
            feeAmountRaw: parseUnsignedRaw(
              row.fee_amount_raw,
              "fee_amount_raw",
            ),
          }),
    },
    provider: row.provider,
    fillPolicyVersion: row.fill_policy_version,
  };
}

function projectPaperFillApplication(
  row: FillApplicationRow,
  application: FollowerFillApplicationEvidence,
): PaperFillApplicationOutcomeEvidence {
  if (!Number.isSafeInteger(row.position_id) || row.position_id < 0) {
    throw new Error(`INVALID_POSITION_ID:${row.fill_id}`);
  }
  if (!Number.isSafeInteger(row.applied_at_ms) || row.applied_at_ms < 0) {
    throw new Error(`INVALID_APPLICATION_TIMESTAMP:${row.fill_id}`);
  }
  return {
    fillId: application.fillId,
    positionId: row.position_id,
    transition: application.transition,
    positionVersionAfter: application.positionVersionAfter,
    appliedAtMs: row.applied_at_ms,
  };
}

export class StrategyEvaluationReadModel {
  readSnapshot(
    request: StrategyEvaluationReadSnapshotRequest,
  ): StrategyEvaluationReadSnapshot {
    const databasePath = requireDatabasePath(request?.databasePath);
    if (request?.window === undefined) {
      throw new Error("EVALUATION_WINDOW_REQUIRED");
    }
    if (request.expectedContext === undefined) {
      throw new Error("EXPECTED_EVALUATION_CONTEXT_REQUIRED");
    }
    validateWindow(request.window);
    validateExpectedContext(request.expectedContext, request.window);
    validateShadowPaperEvidenceBinding(request.shadowPaperEvidenceBinding);
    const database = new SqliteDatabase({
      path: databasePath,
      migrationsDirectory: "",
      readOnly: true,
    });
    try {
      return database.sqlite.transaction(() => {
        const observedSchemaMigrations = validateSchema(database);
        const hasFeeEvidenceContractId = observedSchemaMigrations.some(
          ({ version }) =>
            version === "0009_paper_fee_evidence_contract_v1.sql",
        );
        const orphan = database.sqlite
          .prepare(
            `SELECT pfa.fill_id
             FROM paper_fill_applications pfa
             LEFT JOIN paper_fills pf ON pf.id = pfa.fill_id
             WHERE pf.id IS NULL
             ORDER BY pfa.fill_id
             LIMIT 1`,
          )
          .get() as { fill_id: string } | undefined;
        if (orphan !== undefined) {
          throw new Error(
            `ORPHAN_PAPER_FILL_APPLICATION_EVIDENCE:${orphan.fill_id}`,
          );
        }
        const rows = database.sqlite
          .prepare(
            `SELECT
               pf.id AS fill_id,
               pf.intent_id,
               pf.leader_trade_id,
               ft.execution_key AS joined_follower_execution_key,
               ft.leader_trade_id AS joined_follower_leader_trade_id,
               lt.id AS joined_leader_trade_id,
               fw.address AS joined_follower_wallet,
               lw.address AS joined_leader_wallet,
               ft.side AS joined_follower_side,
               lt.side AS joined_leader_side,
               ft.token_mint AS joined_follower_token_mint,
               lt.token_mint AS joined_leader_token_mint,
               ft.quote_mint AS joined_follower_quote_mint,
               lt.quote_mint AS joined_leader_quote_mint,
               pfa.position_id,
               pf.follower_wallet,
               pf.leader_wallet,
               pf.side,
               pf.input_mint,
               pf.output_mint,
               pf.input_amount_raw,
               pf.output_amount_raw,
               pf.quote_timestamp_ms,
               pfa.transition,
               pfa.quantity_before_raw,
               pfa.quantity_after_raw,
               pfa.allocated_cost_basis_raw,
               pfa.proceeds_raw,
               pfa.realized_pnl_delta_raw,
               pfa.position_version_after,
               pfa.applied_at_ms,
               lt.source_timestamp_ms,
               lt.source_timestamp_precision,
               lt.source_timestamp_provenance,
               fp.id AS accounting_position_id,
               fp.accounting_policy_version,
               fpw.address AS position_follower_wallet,
               plw.address AS position_leader_wallet,
               fp.token_mint AS position_token_mint,
               fp.quote_mint AS position_quote_mint
             FROM paper_fill_applications pfa
             JOIN paper_fills pf ON pf.id = pfa.fill_id
             LEFT JOIN follower_trades ft ON ft.execution_key = pf.intent_id
             LEFT JOIN leader_trades lt ON lt.id = ft.leader_trade_id
             LEFT JOIN wallets fw ON fw.id = ft.follower_wallet_id
             LEFT JOIN wallets lw ON lw.id = lt.leader_wallet_id
             LEFT JOIN follower_positions fp ON fp.id = pfa.position_id
             LEFT JOIN wallets fpw ON fpw.id = fp.follower_wallet_id
             LEFT JOIN wallets plw ON plw.id = fp.leader_wallet_id`,
          )
          .all() as FillApplicationRow[];
        const jupiterRows = database.sqlite
          .prepare(
            `SELECT
               jsq.validation_event_id,
               jsq.execution_key,
               ft.execution_key AS follower_execution_key,
               lt.id AS leader_trade_id,
               fw.id AS follower_wallet_id,
               lw.id AS leader_wallet_id,
               fw.address AS follower_wallet,
               lw.address AS leader_wallet,
               ft.side AS follower_side,
               lt.side AS leader_side,
               ft.token_mint AS follower_token_mint,
               lt.token_mint AS leader_token_mint,
               ft.quote_mint AS follower_quote_mint,
               lt.quote_mint AS leader_quote_mint,
               jsq.input_mint,
               jsq.output_mint,
               jsq.http_status,
               jsq.schema_valid,
               jsq.expected_output_raw,
               jsq.route_json
             FROM jupiter_shadow_quotes jsq
             LEFT JOIN follower_trades ft ON ft.execution_key = jsq.execution_key
             LEFT JOIN leader_trades lt ON lt.id = ft.leader_trade_id
             LEFT JOIN wallets fw ON fw.id = ft.follower_wallet_id
             LEFT JOIN wallets lw ON lw.id = lt.leader_wallet_id`,
          )
          .all() as JupiterAttemptRow[];
        const riskRows = database.sqlite
          .prepare(
            `SELECT
               rd.decision_id,
               rd.phase,
               rd.intent_id,
               rd.leader_trade_id AS risk_leader_trade_id,
               rd.leader_wallet AS risk_leader_wallet,
               rd.follower_wallet AS risk_follower_wallet,
               rd.side AS risk_side,
               rd.token_mint AS risk_token_mint,
               rd.quote_mint AS risk_quote_mint,
               rd.pre_decision_id,
               rd.quote_request_id,
               rd.decision,
               rd.requested_amount_raw,
               rd.approved_amount_raw,
               rd.requested_token_raw,
               rd.approved_token_raw,
               rd.requested_quote_raw,
               rd.approved_quote_raw,
               rd.reason_code,
               rd.policy_version,
               rd.relevant_limit_raw,
               rd.relevant_evidence_json,
               rd.decided_at_ms,
               ft.execution_key AS follower_execution_key,
               ft.leader_trade_id AS follower_leader_trade_id,
               lt.id AS joined_leader_trade_id,
               fw.id AS follower_wallet_id,
               lw.id AS leader_wallet_id,
               fw.address AS joined_follower_wallet,
               lw.address AS joined_leader_wallet,
               ft.side AS follower_side,
               lt.side AS leader_side,
               ft.token_mint AS follower_token_mint,
               lt.token_mint AS leader_token_mint,
               ft.quote_mint AS follower_quote_mint,
               lt.quote_mint AS leader_quote_mint
             FROM risk_decisions rd
             LEFT JOIN follower_trades ft ON ft.execution_key = rd.intent_id
             LEFT JOIN leader_trades lt ON lt.id = ft.leader_trade_id
             LEFT JOIN wallets fw ON fw.id = ft.follower_wallet_id
             LEFT JOIN wallets lw ON lw.id = lt.leader_wallet_id`,
          )
          .all() as RiskDecisionRow[];
        const opportunityRows = database.sqlite
          .prepare(
            `SELECT
               ft.execution_key,
               ft.leader_trade_id,
               ft.follower_wallet_id,
               ft.state,
               ft.side AS follower_side,
               ft.token_mint AS follower_token_mint,
               ft.quote_mint AS follower_quote_mint,
               ft.copy_ratio_bps,
               ft.skip_reason,
               lt.id AS joined_leader_trade_id,
               lw.id AS leader_wallet_id,
               fw.id AS joined_follower_wallet_id,
               fw.address AS follower_wallet,
               lw.address AS leader_wallet,
               lt.signature,
               lt.event_index,
               lt.side AS leader_side,
               lt.token_mint AS leader_token_mint,
               lt.quote_mint AS leader_quote_mint,
               lt.source_timestamp_ms,
               lt.source_timestamp_precision,
               lt.source_timestamp_provenance
             FROM follower_trades ft
             LEFT JOIN leader_trades lt ON lt.id = ft.leader_trade_id
             LEFT JOIN wallets fw ON fw.id = ft.follower_wallet_id
             LEFT JOIN wallets lw ON lw.id = lt.leader_wallet_id`,
          )
          .all() as FollowerOpportunityRow[];
        const observationRows = database.sqlite
          .prepare(
            `SELECT
               id,
               signature,
               event_index,
               leader,
               system_classification,
               ground_truth_classification,
               token_mint,
               quote_mint,
               skip_reason,
               is_duplicate
             FROM live_validation_events`,
          )
          .all() as ObservationRow[];
        const opportunityPaperFillRows = database.sqlite
          .prepare(
            `SELECT
               id,
               intent_id,
               leader_trade_id,
               leader_tx_signature,
               leader_wallet,
               follower_wallet,
               side,
               input_mint,
               output_mint,
               fee_evidence_status,
               ${
                 hasFeeEvidenceContractId
                   ? "fee_evidence_contract_id"
                   : "NULL AS fee_evidence_contract_id"
               },
               fee_bps,
               fee_mint,
               fee_amount_raw,
               provider,
               fill_policy_version
             FROM paper_fills`,
          )
          .all() as OpportunityPaperFillRow[];
        const intentModeRows = database.sqlite
          .prepare(
            `SELECT aggregate_id, payload_json
             FROM outbox
             WHERE aggregate_type = 'EXECUTION'
               AND event_type = 'INTENT_RESERVED'`,
          )
          .all() as IntentModeRow[];
        const leaderObservationTimestampRows = database.sqlite
          .prepare(
            `SELECT
               lt.signature,
               lt.event_index,
               lw.address AS leader_wallet,
               lt.source_timestamp_ms,
               lt.source_timestamp_precision,
               lt.source_timestamp_provenance
             FROM leader_trades lt
             JOIN wallets lw ON lw.id = lt.leader_wallet_id`,
          )
          .all() as LeaderObservationTimestampRow[];
        const rootExecutionKeys = new Set(
          opportunityRows.map((row) => row.execution_key),
        );
        const allJupiterAttempts = projectJupiterAttempts(jupiterRows).sort(
          compareJupiterAttempts,
        );
        const allRiskDecisions =
          projectRiskDecisions(riskRows).sort(compareRiskDecisions);
        for (const fill of opportunityPaperFillRows) {
          if (!rootExecutionKeys.has(fill.intent_id)) {
            throw new Error(`PAPER_FILL_WITHOUT_OPPORTUNITY:${fill.id}`);
          }
        }
        const windowCandidateRows = opportunityRows.filter((row) =>
          isAuthoritativeWindowOpportunity(row, request.window),
        );
        const windowCandidateExecutionKeys = new Set(
          windowCandidateRows.map((row) => row.execution_key),
        );
        const windowCandidateRiskDecisions = allRiskDecisions.filter(
          (decision) => windowCandidateExecutionKeys.has(decision.intentId),
        );
        const windowCandidatePaperFillRows = opportunityPaperFillRows.filter(
          (row) => windowCandidateExecutionKeys.has(row.intent_id),
        );
        const windowCandidateFillIds = new Set(
          windowCandidatePaperFillRows.map((row) => row.id),
        );
        const windowCandidateApplicationRows = rows.filter((row) =>
          windowCandidateFillIds.has(row.fill_id),
        );
        const windowCandidateApplications = windowCandidateApplicationRows
          .map(projectApplication)
          .sort(compareApplications);
        const intentModes = projectIntentModes(
          intentModeRows.filter((row) =>
            windowCandidateExecutionKeys.has(row.aggregate_id),
          ),
        );
        const contextCohort = resolveContextCohort(
          windowCandidateRows,
          intentModes,
          windowCandidateRiskDecisions,
          windowCandidatePaperFillRows,
          windowCandidateApplicationRows,
          request.expectedContext,
          request.shadowPaperEvidenceBinding,
        );
        const opportunityWindowLimitations = opportunityRows
          .filter(
            (row) =>
              !isAuthoritativeSourceTimestamp(
                row.source_timestamp_ms,
                row.source_timestamp_provenance ?? "UNKNOWN",
                row.source_timestamp_precision ?? "UNKNOWN",
              ),
          )
          .map((row) =>
            contextLimitation(
              projectOpportunityRoot(row),
              "WINDOW_MEMBERSHIP_UNPROVEN",
            ),
          );
        const observationWindow = resolveObservationWindow(
          observationRows,
          leaderObservationTimestampRows,
          request.window,
        );
        const followerObservationIdentities = new Set(
          opportunityRows.flatMap((row) =>
            row.signature === null ||
            row.event_index === null ||
            row.leader_wallet === null
              ? []
              : [
                  observationIdentity(
                    row.signature,
                    row.leader_wallet,
                    row.event_index,
                  ),
                ],
          ),
        );
        const cohortOpportunityRows = contextCohort.acceptedRows;
        const cohortExecutionKeys = new Set(
          cohortOpportunityRows.map((row) => row.execution_key),
        );
        const replayPositionIdentities = new Set(
          cohortOpportunityRows.map((row) =>
            [
              row.follower_wallet,
              row.leader_wallet,
              row.follower_token_mint,
              row.follower_quote_mint,
            ].join("\u0000"),
          ),
        );
        const relevantReplayRows = rows.filter((row) =>
          replayPositionIdentities.has(paperApplicationPositionIdentity(row)),
        );
        const replayExecutionKeys = new Set(
          relevantReplayRows.map((row) => row.intent_id),
        );
        const replayContextCohort = resolveContextCohort(
          opportunityRows.filter((row) =>
            replayExecutionKeys.has(row.execution_key),
          ),
          projectIntentModes(
            intentModeRows.filter((row) =>
              replayExecutionKeys.has(row.aggregate_id),
            ),
          ),
          allRiskDecisions.filter((decision) =>
            replayExecutionKeys.has(decision.intentId),
          ),
          opportunityPaperFillRows.filter((row) =>
            replayExecutionKeys.has(row.intent_id),
          ),
          relevantReplayRows,
          request.expectedContext,
          request.shadowPaperEvidenceBinding,
        );
        const replayWindowLimitations = relevantReplayRows
          .filter(
            (row) =>
              !isAuthoritativeSourceTimestamp(
                row.source_timestamp_ms,
                row.source_timestamp_provenance,
                row.source_timestamp_precision,
              ),
          )
          .map((row) =>
            contextLimitation(
              paperApplicationContextScope(row),
              "WINDOW_MEMBERSHIP_UNPROVEN",
            ),
          );
        const roundTripApplications = relevantReplayRows
          .filter(
            (row) =>
              isAuthoritativeSourceTimestamp(
                row.source_timestamp_ms,
                row.source_timestamp_provenance,
                row.source_timestamp_precision,
              ) && row.source_timestamp_ms < request.window.windowEndMs,
          )
          .map(projectApplication)
          .sort(compareApplications);
        const replayRowByFillId = new Map(
          relevantReplayRows.map((row) => [row.fill_id, row] as const),
        );
        const roundTripApplicationSources = roundTripApplications.map(
          (application) => {
            const row = replayRowByFillId.get(application.fillId);
            if (
              row === undefined ||
              !isAuthoritativeSourceTimestamp(
                row.source_timestamp_ms,
                row.source_timestamp_provenance,
                row.source_timestamp_precision,
              )
            ) {
              throw new Error(
                `ROUND_TRIP_SOURCE_TIMESTAMP_UNAVAILABLE:${application.fillId}`,
              );
            }
            return {
              fillId: application.fillId,
              executionKey: row.intent_id,
              leaderTradeId: row.leader_trade_id,
              sourceTimestamp: {
                valueMs: row.source_timestamp_ms,
                provenance: "CHAIN_BLOCK_TIME",
                precision:
                  row.source_timestamp_precision === "MILLISECOND"
                    ? "MILLISECOND"
                    : "SECOND",
              },
            } satisfies RoundTripApplicationSourceEvidence;
          },
        );
        const cohortPaperFillRows = opportunityPaperFillRows.filter((row) =>
          cohortExecutionKeys.has(row.intent_id),
        );
        const cohortFillIds = new Set(cohortPaperFillRows.map((row) => row.id));
        const paperFills = cohortPaperFillRows
          .map(projectPaperFill)
          .sort(comparePaperFills);
        const windowCandidateApplicationByFillId = new Map(
          windowCandidateApplications.map((application) => [
            application.fillId,
            application,
          ]),
        );
        const paperFillApplications = rows
          .filter((row) => cohortFillIds.has(row.fill_id))
          .map((row) => {
            const application = windowCandidateApplicationByFillId.get(
              row.fill_id,
            );
            if (application === undefined) {
              throw new Error(
                `MISSING_ROUND_TRIP_APPLICATION_PROJECTION:${row.fill_id}`,
              );
            }
            return projectPaperFillApplication(row, application);
          })
          .sort(comparePaperFillApplications);
        const jupiterAttempts = allJupiterAttempts.filter((attempt) =>
          cohortExecutionKeys.has(attempt.executionKey),
        );
        const riskDecisions = windowCandidateRiskDecisions.filter((decision) =>
          cohortExecutionKeys.has(decision.intentId),
        );
        const opportunityProjection = projectOpportunities(
          cohortOpportunityRows,
          observationWindow.rows,
          observationWindow.limitationReasons,
          followerObservationIdentities,
          jupiterAttempts,
          riskDecisions,
          cohortPaperFillRows,
          windowCandidateApplications.filter((application) =>
            cohortFillIds.has(application.fillId),
          ),
        );
        return {
          provenance: projectSnapshotProvenance(
            databasePath,
            observedSchemaMigrations,
            request.window,
            request.expectedContext,
            request.shadowPaperEvidenceBinding,
          ),
          roundTripApplications,
          roundTripApplicationSources,
          paperFills,
          paperFillApplications,
          jupiterAttempts,
          riskDecisions,
          ...opportunityProjection,
          contextLimitations: deduplicateContextLimitations([
            ...opportunityWindowLimitations,
            ...contextCohort.limitations,
            ...observationWindow.limitations,
            ...replayContextCohort.limitations,
            ...replayWindowLimitations,
          ]),
        };
      })();
    } finally {
      database.close();
    }
  }
}
