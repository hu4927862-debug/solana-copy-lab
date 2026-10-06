import { describe, expect, expectTypeOf, it } from "vitest";
import {
  calculateEndToEndApplicationCompatibility,
  type CopyabilityBucket,
} from "../../src/strategy-evaluation/copyability.js";
import {
  evaluateHistoricalEvaluation,
  type HistoricalEvaluationResult,
  type VersionedHistoricalEvaluationResult,
} from "../../src/strategy-evaluation/historical-evaluation.js";
import {
  evaluateLeaderComparability,
  type LeaderComparabilityReason,
  type LeaderComparabilityResult,
} from "../../src/strategy-evaluation/leader-comparability.js";
import type { StrategyEvaluationEvidenceSnapshot } from "../../src/strategy-evaluation/read-model.js";
import type { CompletedFollowerRoundTrip } from "../../src/strategy-evaluation/round-trips.js";

const BUCKET: CopyabilityBucket = {
  followerWallet: "follower-a",
  leaderWallet: "leader-a",
  quoteMint: "SOL_NATIVE",
};
const WINDOW = { windowStartMs: 1_000, windowEndMs: 2_000 } as const;
const EVALUATION_CONTEXT = {
  window: { fromMs: WINDOW.windowStartMs, toMs: WINDOW.windowEndMs },
  source: "fixture",
  mode: "PAPER",
  copyRatioBps: 10_000,
  riskPolicyVersion: "RISK_V1",
  fillPolicyVersion: "FILL_V1",
  accountingPolicyVersion: "ACCOUNTING_V1",
  copyabilityDefinitionVersion: "COPYABILITY_V1",
} as const;
const STRATEGY_METRICS_POLICY = {
  definitionVersion: "STRATEGY_METRICS_V1",
  minimumCompletedCycles: 20,
} as const;
const FAILURE_TAXONOMY_POLICY = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
} as const;

function emptySnapshot(
  bucket: CopyabilityBucket = BUCKET,
): StrategyEvaluationEvidenceSnapshot {
  return {
    provenance: {
      resolvedDatabasePath: `/fixture/${bucket.leaderWallet}.sqlite`,
      observedSchemaMigrations: [
        { version: "0001_fixture", checksum: "sha256:fixture" },
      ],
      requestedWindow: { ...WINDOW },
      expectedContext: {
        ...EVALUATION_CONTEXT,
        window: { ...EVALUATION_CONTEXT.window },
      },
    },
    roundTripApplications: [],
    roundTripApplicationSources: [],
    paperFills: [],
    paperFillApplications: [],
    jupiterAttempts: [],
    riskDecisions: [],
    opportunities: [],
    observationExclusions: [],
    observationLimitations: [],
    contextLimitations: [],
  };
}

interface HistoricalFixtureOverrides {
  readonly bucket?: CopyabilityBucket;
  readonly availability?: HistoricalEvaluationResult["availability"];
  readonly sample?: Partial<HistoricalEvaluationResult["sample"]>;
  readonly expectancy?: Partial<
    HistoricalEvaluationResult["strategyMetrics"]["netQuoteExpectancy"]
  >;
  readonly endToEnd?: Partial<
    HistoricalEvaluationResult["copyability"]["endToEndApplication"]
  >;
  readonly includedRoundTrips?: readonly CompletedFollowerRoundTrip[];
}

function historicalFixture(
  overrides: HistoricalFixtureOverrides = {},
): HistoricalEvaluationResult {
  const bucket = overrides.bucket ?? BUCKET;
  const baseline = evaluateHistoricalEvaluation(
    emptySnapshot(bucket),
    bucket,
    STRATEGY_METRICS_POLICY,
    FAILURE_TAXONOMY_POLICY,
  );

  return {
    ...baseline,
    availability: overrides.availability ?? "AVAILABLE",
    sample: {
      ...baseline.sample,
      fullyContainedCount: 30,
      sampleStatus: "PROVISIONAL",
      ...overrides.sample,
    },
    includedRoundTrips:
      overrides.includedRoundTrips ?? baseline.includedRoundTrips,
    strategyMetrics: {
      ...baseline.strategyMetrics,
      netQuoteExpectancy: {
        ...baseline.strategyMetrics.netQuoteExpectancy,
        value: "5",
        sampleCount: 30,
        status: "AVAILABLE",
        ...overrides.expectancy,
      },
    },
    copyability: {
      ...baseline.copyability,
      endToEndApplication: {
        ...baseline.copyability.endToEndApplication,
        endToEndOpportunityCount: 1,
        applicationSuccessCount: 1,
        endToEndApplicationCompatibilityRate: "1",
        preconditionCount: 1,
        evaluableCount: 1,
        coverageRate: "1",
        status: "AVAILABLE",
        ...overrides.endToEnd,
      },
    },
  };
}

function roundTrip(tokenMint: string): CompletedFollowerRoundTrip {
  return {
    ...BUCKET,
    tokenMint,
    openFillId: `open-${tokenMint}`,
    closeFillId: `close-${tokenMint}`,
    fillIds: [`open-${tokenMint}`, `close-${tokenMint}`],
    entryCostQuoteRaw: 100n,
    proceedsQuoteRaw: 105n,
    realizedPnlQuoteRaw: 5n,
    openedAtMs: 1_100,
    closedAtMs: 1_200,
    holdingTimeMs: 100,
  };
}

describe("evaluateLeaderComparability", () => {
  it("exposes a pure single-Historical-result API", () => {
    expectTypeOf(evaluateLeaderComparability)
      .parameter(0)
      .toEqualTypeOf<VersionedHistoricalEvaluationResult>();
    expectTypeOf(
      evaluateLeaderComparability,
    ).returns.toEqualTypeOf<LeaderComparabilityResult>();
  });

  it.each([
    {
      fixture: "A",
      historical: historicalFixture(),
      status: "COMPARABLE",
      reasons: [],
    },
    {
      fixture: "B",
      historical: historicalFixture({
        sample: { sampleStatus: "INSUFFICIENT_SAMPLE" },
      }),
      status: "NOT_COMPARABLE",
      reasons: ["INSUFFICIENT_SAMPLE"],
    },
    {
      fixture: "C",
      historical: historicalFixture({
        sample: { sampleStatus: "EXPLORATORY" },
      }),
      status: "OBSERVATION_ONLY",
      reasons: ["EXPLORATORY_SAMPLE"],
    },
    {
      fixture: "D",
      historical: historicalFixture({ availability: "LIMITED" }),
      status: "NOT_COMPARABLE",
      reasons: ["LIMITED_EVIDENCE"],
    },
    {
      fixture: "E",
      historical: historicalFixture({ sample: { leftCensoredCount: 1 } }),
      status: "OBSERVATION_ONLY",
      reasons: ["CENSORED_LIFECYCLE_EVIDENCE"],
    },
    {
      fixture: "F",
      historical: historicalFixture({
        expectancy: { value: null, status: "NO_TRADES" },
      }),
      status: "NOT_COMPARABLE",
      reasons: ["NO_EVALUABLE_STRATEGY_DATA"],
    },
    {
      fixture: "G",
      historical: historicalFixture({
        endToEnd: {
          endToEndApplicationCompatibilityRate: null,
          evaluableCount: 0,
          status: "NO_EVALUABLE_END_TO_END_OUTCOMES",
        },
      }),
      status: "NOT_COMPARABLE",
      reasons: ["NO_EVALUABLE_COPYABILITY_DATA"],
    },
    {
      fixture: "H",
      historical: historicalFixture({
        availability: "LIMITED",
        sample: { leftCensoredCount: 1 },
        expectancy: { value: null, status: "NO_TRADES" },
      }),
      status: "NOT_COMPARABLE",
      reasons: [
        "LIMITED_EVIDENCE",
        "CENSORED_LIFECYCLE_EVIDENCE",
        "NO_EVALUABLE_STRATEGY_DATA",
      ],
    },
  ] as const)(
    "routes fixture $fixture to $status and preserves all applicable reasons",
    ({ historical, status, reasons }) => {
      expect(evaluateLeaderComparability(historical)).toMatchObject({
        bucket: BUCKET,
        status,
        reasons,
        sampleStatus: historical.sample.sampleStatus,
        availability: historical.availability,
      });
    },
  );

  it.each([
    "leftCensoredCount",
    "rightCensoredCount",
    "preWindowOpenCount",
    "sourceUnavailableCount",
  ] as const)("keeps non-zero %s observation-only", (field) => {
    const result = evaluateLeaderComparability(
      historicalFixture({ sample: { [field]: 1 } }),
    );

    expect(result).toMatchObject({
      status: "OBSERVATION_ONLY",
      reasons: ["CENSORED_LIFECYCLE_EVIDENCE"],
    });
  });

  it("consumes sampleStatus without reconstructing Historical sample thresholds", () => {
    expect(
      evaluateLeaderComparability(
        historicalFixture({
          sample: { fullyContainedCount: 0, sampleStatus: "PROVISIONAL" },
        }),
      ),
    ).toMatchObject({ status: "COMPARABLE", reasons: [] });
    expect(
      evaluateLeaderComparability(
        historicalFixture({
          sample: {
            fullyContainedCount: 1_000,
            sampleStatus: "INSUFFICIENT_SAMPLE",
          },
        }),
      ),
    ).toMatchObject({
      status: "NOT_COMPARABLE",
      reasons: ["INSUFFICIENT_SAMPLE"],
    });
  });

  it.each([
    { label: "null expectancy", value: null, status: "AVAILABLE" },
    { label: "NO_TRADES expectancy", value: null, status: "NO_TRADES" },
  ] as const)("excludes $label without coercing it to zero", (expectancy) => {
    expect(
      evaluateLeaderComparability(
        historicalFixture({ expectancy: { ...expectancy } }),
      ),
    ).toMatchObject({
      status: "NOT_COMPARABLE",
      reasons: ["NO_EVALUABLE_STRATEGY_DATA"],
    });
  });

  it.each([
    {
      label: "null rate",
      endToEnd: { endToEndApplicationCompatibilityRate: null },
    },
    { label: "zero evaluable outcomes", endToEnd: { evaluableCount: 0 } },
  ] as const)("excludes E2E evidence with $label", ({ endToEnd }) => {
    expect(
      evaluateLeaderComparability(historicalFixture({ endToEnd })),
    ).toMatchObject({
      status: "NOT_COMPARABLE",
      reasons: ["NO_EVALUABLE_COPYABILITY_DATA"],
    });
  });

  it("does not reinterpret intermediate Jupiter NOT_A_FAILURE as evaluable E2E success", () => {
    const endToEnd = calculateEndToEndApplicationCompatibility(
      BUCKET,
      [
        {
          ...BUCKET,
          executionKey: "intermediate-jupiter",
          side: "BUY",
          failureClassification: {
            classificationStatus: "NOT_A_FAILURE",
            primaryCategory: null,
            stage: "JUPITER_ORDER",
            reasonCode: null,
            definitionVersion: "OPPORTUNITY_FAILURE_V1",
          },
        },
      ],
      EVALUATION_CONTEXT,
    );

    expect(endToEnd).toMatchObject({
      applicationSuccessCount: 0,
      evaluableCount: 0,
      status: "NO_EVALUABLE_END_TO_END_OUTCOMES",
    });
    expect(
      evaluateLeaderComparability(historicalFixture({ endToEnd })),
    ).toMatchObject({
      status: "NOT_COMPARABLE",
      reasons: ["NO_EVALUABLE_COPYABILITY_DATA"],
    });
  });

  it("accepts evaluable 0% E2E evidence without inventing a rate threshold", () => {
    expect(
      evaluateLeaderComparability(
        historicalFixture({
          endToEnd: {
            endToEndOpportunityCount: 2,
            applicationSuccessCount: 0,
            terminalFailureCount: 2,
            endToEndApplicationCompatibilityRate: "0",
            preconditionCount: 2,
            evaluableCount: 2,
            coverageRate: "1",
            status: "AVAILABLE",
          },
        }),
      ),
    ).toMatchObject({ status: "COMPARABLE", reasons: [] });
  });

  it("keeps zero expectancy distinct from unknown expectancy", () => {
    expect(
      evaluateLeaderComparability(
        historicalFixture({
          expectancy: { value: "0", status: "AVAILABLE" },
        }),
      ),
    ).toMatchObject({ status: "COMPARABLE", reasons: [] });
  });

  it("gives hard exclusions precedence while retaining observation reasons in stable order", () => {
    expect(
      evaluateLeaderComparability(
        historicalFixture({
          availability: "LIMITED",
          sample: {
            sampleStatus: "EXPLORATORY",
            rightCensoredCount: 1,
          },
          expectancy: { value: null, status: "NO_TRADES" },
          endToEnd: {
            endToEndApplicationCompatibilityRate: null,
            evaluableCount: 0,
            status: "NO_EVALUABLE_END_TO_END_OUTCOMES",
          },
        }),
      ),
    ).toMatchObject({
      status: "NOT_COMPARABLE",
      reasons: [
        "EXPLORATORY_SAMPLE",
        "LIMITED_EVIDENCE",
        "CENSORED_LIFECYCLE_EVIDENCE",
        "NO_EVALUABLE_STRATEGY_DATA",
        "NO_EVALUABLE_COPYABILITY_DATA",
      ],
    });
  });

  it("uses follower + leader + quote as the bucket and ignores token-level evidence", () => {
    const tokenA = evaluateLeaderComparability(
      historicalFixture({ includedRoundTrips: [roundTrip("TOKEN_A")] }),
    );
    const tokenB = evaluateLeaderComparability(
      historicalFixture({ includedRoundTrips: [roundTrip("TOKEN_B")] }),
    );

    expect(tokenA).toEqual(tokenB);
    expect(tokenA.bucket).toEqual(BUCKET);
    expect(tokenA.bucket).not.toHaveProperty("tokenMint");
  });

  it("is deterministic and returns defensive identity, reasons, and reference data", () => {
    const historical = historicalFixture({
      sample: { sampleStatus: "EXPLORATORY", leftCensoredCount: 1 },
    });
    const first = evaluateLeaderComparability(historical);
    const second = evaluateLeaderComparability(historical);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.bucket).not.toBe(historical.bucket);
    expect(first.reasons).not.toBe(second.reasons);
    expect(first.historicalReference.window).not.toBe(historical.window);
    expect(first.historicalReference.evaluationContext).not.toBe(
      historical.evaluationContext,
    );
    expect(first.historicalReference.observedSchemaMigrations).not.toBe(
      historical.provenance.observedSchemaMigrations,
    );

    const mutableHistorical = historical as unknown as {
      bucket: {
        followerWallet: string;
        leaderWallet: string;
        quoteMint: string;
      };
      window: { windowStartMs: number; windowEndMs: number };
      evaluationContext: { window: { fromMs: number; toMs: number } };
      provenance: {
        observedSchemaMigrations: Array<{ version: string; checksum: string }>;
      };
    };
    mutableHistorical.bucket.leaderWallet = "changed-leader";
    mutableHistorical.window.windowStartMs = 999;
    mutableHistorical.evaluationContext.window.fromMs = 999;
    mutableHistorical.provenance.observedSchemaMigrations[0]!.checksum =
      "changed";
    (second.reasons as LeaderComparabilityReason[]).push("LIMITED_EVIDENCE");

    expect(first.bucket).toEqual(BUCKET);
    expect(first.historicalReference).toMatchObject({
      window: WINDOW,
      evaluationContext: EVALUATION_CONTEXT,
      observedSchemaMigrations: [
        { version: "0001_fixture", checksum: "sha256:fixture" },
      ],
    });
    expect(first.reasons).toEqual([
      "EXPLORATORY_SAMPLE",
      "CENSORED_LIFECYCLE_EVIDENCE",
    ]);
  });

  it("exposes only historical comparison eligibility fields", () => {
    const result = evaluateLeaderComparability(historicalFixture());

    expect(Object.keys(result)).toEqual([
      "bucket",
      "status",
      "reasons",
      "sampleStatus",
      "availability",
      "historicalReference",
    ]);
    const keys: string[] = [];
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        visit(child);
      }
    };
    visit(result);
    for (const forbiddenField of [
      "rank",
      "ranking",
      "score",
      "weightedScore",
      "grade",
      "recommendation",
      "liveReady",
      "approved",
      "capitalWeight",
      "allocation",
    ]) {
      expect(keys).not.toContain(forbiddenField);
    }
  });
});
