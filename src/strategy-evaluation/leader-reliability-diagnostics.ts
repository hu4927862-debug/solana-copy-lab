import type {
  HistoricalEvaluationSampleStatus,
  VersionedHistoricalEvaluationResult,
} from "./historical-evaluation.js";
import {
  evaluateLeaderTemporalCoverageDiagnostics,
  type LeaderTemporalCoverageDiagnosticsResult,
} from "./leader-temporal-coverage-diagnostics.js";
import {
  evaluateLeaderTemporalPerformanceDiagnostics,
  type LeaderTemporalPerformanceDiagnosticsResult,
} from "./leader-temporal-performance-diagnostics.js";

export const LEADER_RELIABILITY_DEFINITION_VERSION =
  "LEADER_RELIABILITY_DIAGNOSTICS_V1" as const;
export const LEADER_RELIABILITY_V2_DEFINITION_VERSION =
  "LEADER_RELIABILITY_DIAGNOSTICS_V2" as const;

export type LeaderReliabilityLimitation =
  | "DEPENDENCE_NOT_MODELED"
  | "HEAVY_TAIL_BEHAVIOR_NOT_CALIBRATED"
  | "IID_CONFIDENCE_INTERVAL_NOT_AVAILABLE"
  | "REAL_DATA_CALIBRATION_REQUIRED"
  | "TEMPORAL_STABILITY_NOT_AVAILABLE"
  | "TOP_K_TRADE_DOMINANCE_NOT_AVAILABLE";

export interface LeaderReliabilityHistoricalReference {
  readonly bucket: VersionedHistoricalEvaluationResult["bucket"];
  readonly window: VersionedHistoricalEvaluationResult["window"];
  readonly historicalEvaluationDefinitionVersion: VersionedHistoricalEvaluationResult["definitionVersion"];
  readonly strategyMetricSemantics: VersionedHistoricalEvaluationResult["strategyMetricSemantics"];
}

export interface LeaderReliabilitySampleDepthDiagnostics {
  readonly fullyContainedCount: number;
  readonly sampleStatus: HistoricalEvaluationSampleStatus;
  readonly independenceStatus: "NOT_ESTABLISHED";
}

export interface LeaderReliabilityCensoringDiagnostics {
  readonly leftCensoredCount: number;
  readonly rightCensoredCount: number;
  readonly preWindowOpenCount: number;
  readonly sourceUnavailableCount: number;
}

export interface LeaderReliabilityConditionalExpectancyDiagnostics {
  readonly metricSemantics: "PAPER_EXPECTANCY";
  readonly pointEstimate: VersionedHistoricalEvaluationResult["strategyMetrics"]["netQuoteExpectancy"];
  readonly sampleCondition: "FULLY_CONTAINED_COMPLETED_ROUND_TRIPS_ONLY";
  readonly incompleteLifecycleTreatment: "EXCLUDED_FROM_STRATEGY_METRICS_DENOMINATOR";
  readonly canonicalFailedOpportunityTreatment: "NOT_IMPUTED_INTO_STRATEGY_METRICS";
}

export interface LeaderReliabilityTradeDominanceDiagnostics {
  readonly capability: "PARTIAL";
  readonly bestTradeContribution: VersionedHistoricalEvaluationResult["strategyMetrics"]["bestTradeContribution"];
  readonly topKTradeDominance: {
    readonly status: "UNAVAILABLE";
    readonly reason: "TOP_K_TRADE_DOMINANCE_NOT_AVAILABLE";
  };
}

export interface LeaderReliabilityTokenConcentrationDiagnostics {
  readonly role: "STRATEGY_STRUCTURE_DIAGNOSTIC";
  readonly bestTokenContribution: VersionedHistoricalEvaluationResult["strategyMetrics"]["bestTokenContribution"];
  readonly tradeLevelDominanceSubstitute: false;
}

export interface LeaderReliabilityTemporalStabilityDiagnostics {
  readonly status: "UNAVAILABLE";
  readonly reason: "AUTHORITATIVE_LIFECYCLE_TIME_NOT_EXPOSED";
  readonly dataCollectionRequired: "NO";
  readonly historicalContract: "PARTIALLY_SUFFICIENT";
}

export interface LeaderReliabilityConfidenceIntervalDiagnostics {
  readonly status: "UNAVAILABLE";
  readonly reason: "DEPENDENCE_AWARE_INFERENCE_METHOD_NOT_ESTABLISHED";
}

export interface LeaderReliabilityMethodology {
  readonly dependenceModelStatus: "NOT_MODELED";
  readonly heavyTailCalibrationStatus: "NOT_CALIBRATED";
  readonly iidBootstrapStatus: "REJECTED_AS_DEFAULT_FOR_EXPECTANCY_CI";
  readonly shrinkageStatus: "NOT_APPLIED";
  readonly estimateDirectionInferenceStatus: "DEFERRED";
  readonly bandThresholdsStatus: "NOT_YET_JUSTIFIED";
  readonly realDataCalibrationStatus: "REQUIRED";
}

export interface LeaderReliabilityOpportunityRealizationContext {
  readonly status: "AVAILABLE_SEPARATELY_IN_HISTORICAL_RESULT";
  readonly failureClassificationDefinitionVersion: string;
  readonly endToEndApplicationDefinitionVersion: string;
}

export interface LeaderReliabilityDiagnosticsResult {
  readonly definitionVersion: typeof LEADER_RELIABILITY_DEFINITION_VERSION;
  readonly historicalReference: LeaderReliabilityHistoricalReference;
  readonly sampleDepth: LeaderReliabilitySampleDepthDiagnostics;
  readonly censoring: LeaderReliabilityCensoringDiagnostics;
  readonly conditionalExpectancy: LeaderReliabilityConditionalExpectancyDiagnostics;
  readonly tradeDominance: LeaderReliabilityTradeDominanceDiagnostics;
  readonly tokenConcentration: LeaderReliabilityTokenConcentrationDiagnostics;
  readonly temporalStability: LeaderReliabilityTemporalStabilityDiagnostics;
  readonly confidenceInterval: LeaderReliabilityConfidenceIntervalDiagnostics;
  readonly methodology: LeaderReliabilityMethodology;
  readonly opportunityRealizationContext: LeaderReliabilityOpportunityRealizationContext;
  readonly limitations: readonly LeaderReliabilityLimitation[];
}

export interface LeaderReliabilityDiagnosticsV2ReportingConvention {
  readonly temporalBlockCount: number;
}

export type LeaderReliabilityV2Limitation = Exclude<
  LeaderReliabilityLimitation,
  "TEMPORAL_STABILITY_NOT_AVAILABLE"
>;

export interface LeaderReliabilityDiagnosticsV2Result extends Omit<
  LeaderReliabilityDiagnosticsResult,
  "definitionVersion" | "temporalStability" | "limitations"
> {
  readonly definitionVersion: typeof LEADER_RELIABILITY_V2_DEFINITION_VERSION;
  readonly temporalEvidenceStatus: LeaderTemporalCoverageDiagnosticsResult["temporalEvidenceStatus"];
  readonly temporalStabilityConclusion: "NOT_ESTABLISHED";
  readonly temporalCoverage: LeaderTemporalCoverageDiagnosticsResult;
  readonly temporalPerformance: LeaderTemporalPerformanceDiagnosticsResult;
  readonly limitations: readonly LeaderReliabilityV2Limitation[];
}

export function evaluateLeaderReliabilityDiagnostics(
  historical: VersionedHistoricalEvaluationResult,
): LeaderReliabilityDiagnosticsResult {
  return {
    definitionVersion: LEADER_RELIABILITY_DEFINITION_VERSION,
    historicalReference: {
      bucket: { ...historical.bucket },
      window: { ...historical.window },
      historicalEvaluationDefinitionVersion: historical.definitionVersion,
      strategyMetricSemantics: historical.strategyMetricSemantics,
    },
    sampleDepth: {
      fullyContainedCount: historical.sample.fullyContainedCount,
      sampleStatus: historical.sample.sampleStatus,
      independenceStatus: "NOT_ESTABLISHED",
    },
    censoring: {
      leftCensoredCount: historical.sample.leftCensoredCount,
      rightCensoredCount: historical.sample.rightCensoredCount,
      preWindowOpenCount: historical.sample.preWindowOpenCount,
      sourceUnavailableCount: historical.sample.sourceUnavailableCount,
    },
    conditionalExpectancy: {
      metricSemantics: historical.strategyMetricSemantics,
      pointEstimate: { ...historical.strategyMetrics.netQuoteExpectancy },
      sampleCondition: "FULLY_CONTAINED_COMPLETED_ROUND_TRIPS_ONLY",
      incompleteLifecycleTreatment:
        "EXCLUDED_FROM_STRATEGY_METRICS_DENOMINATOR",
      canonicalFailedOpportunityTreatment: "NOT_IMPUTED_INTO_STRATEGY_METRICS",
    },
    tradeDominance: {
      capability: "PARTIAL",
      bestTradeContribution: {
        ...historical.strategyMetrics.bestTradeContribution,
      },
      topKTradeDominance: {
        status: "UNAVAILABLE",
        reason: "TOP_K_TRADE_DOMINANCE_NOT_AVAILABLE",
      },
    },
    tokenConcentration: {
      role: "STRATEGY_STRUCTURE_DIAGNOSTIC",
      bestTokenContribution: {
        ...historical.strategyMetrics.bestTokenContribution,
      },
      tradeLevelDominanceSubstitute: false,
    },
    temporalStability: {
      status: "UNAVAILABLE",
      reason: "AUTHORITATIVE_LIFECYCLE_TIME_NOT_EXPOSED",
      dataCollectionRequired: "NO",
      historicalContract: "PARTIALLY_SUFFICIENT",
    },
    confidenceInterval: {
      status: "UNAVAILABLE",
      reason: "DEPENDENCE_AWARE_INFERENCE_METHOD_NOT_ESTABLISHED",
    },
    methodology: {
      dependenceModelStatus: "NOT_MODELED",
      heavyTailCalibrationStatus: "NOT_CALIBRATED",
      iidBootstrapStatus: "REJECTED_AS_DEFAULT_FOR_EXPECTANCY_CI",
      shrinkageStatus: "NOT_APPLIED",
      estimateDirectionInferenceStatus: "DEFERRED",
      bandThresholdsStatus: "NOT_YET_JUSTIFIED",
      realDataCalibrationStatus: "REQUIRED",
    },
    opportunityRealizationContext: {
      status: "AVAILABLE_SEPARATELY_IN_HISTORICAL_RESULT",
      failureClassificationDefinitionVersion:
        historical.failureClassification.definitionVersion,
      endToEndApplicationDefinitionVersion:
        historical.copyability.endToEndApplication.definitionVersion,
    },
    limitations: [
      "DEPENDENCE_NOT_MODELED",
      "HEAVY_TAIL_BEHAVIOR_NOT_CALIBRATED",
      "IID_CONFIDENCE_INTERVAL_NOT_AVAILABLE",
      "REAL_DATA_CALIBRATION_REQUIRED",
      "TEMPORAL_STABILITY_NOT_AVAILABLE",
      "TOP_K_TRADE_DOMINANCE_NOT_AVAILABLE",
    ],
  };
}

export function evaluateLeaderReliabilityDiagnosticsV2(
  historical: VersionedHistoricalEvaluationResult,
  reportingConvention: LeaderReliabilityDiagnosticsV2ReportingConvention,
): LeaderReliabilityDiagnosticsV2Result {
  const {
    definitionVersion: _definitionVersion,
    temporalStability: _temporalStability,
    limitations: _limitations,
    ...reliabilityV1
  } = evaluateLeaderReliabilityDiagnostics(historical);
  const temporalReportingConvention = {
    blockCount: reportingConvention.temporalBlockCount,
  };
  const temporalCoverage = evaluateLeaderTemporalCoverageDiagnostics(
    historical,
    temporalReportingConvention,
  );
  const temporalPerformance = evaluateLeaderTemporalPerformanceDiagnostics(
    historical,
    temporalReportingConvention,
  );

  return {
    definitionVersion: LEADER_RELIABILITY_V2_DEFINITION_VERSION,
    ...reliabilityV1,
    temporalEvidenceStatus: temporalCoverage.temporalEvidenceStatus,
    temporalStabilityConclusion: "NOT_ESTABLISHED",
    temporalCoverage,
    temporalPerformance,
    limitations: [
      "DEPENDENCE_NOT_MODELED",
      "HEAVY_TAIL_BEHAVIOR_NOT_CALIBRATED",
      "IID_CONFIDENCE_INTERVAL_NOT_AVAILABLE",
      "REAL_DATA_CALIBRATION_REQUIRED",
      "TOP_K_TRADE_DOMINANCE_NOT_AVAILABLE",
    ],
  };
}
