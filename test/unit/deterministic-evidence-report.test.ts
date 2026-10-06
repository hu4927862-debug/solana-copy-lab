import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CopyabilityEvaluationContext } from "../../src/strategy-evaluation/copyability.js";
import {
  buildDeterministicEvidenceReport,
  renderDeterministicEvidenceReportMarkdown,
  serializeDeterministicEvidenceReport,
} from "../../src/strategy-evaluation/evidence-report.js";
import type { HistoricalEvaluationV2EvidenceSnapshot } from "../../src/strategy-evaluation/historical-evaluation.js";
import type { StrategyEvaluationOpportunityProjection } from "../../src/strategy-evaluation/read-model.js";
import type { DetailedFollowerFillApplicationEvidence } from "../../src/strategy-evaluation/round-trips.js";

const WINDOW = { windowStartMs: 1_000, windowEndMs: 5_000 } as const;
const VERDICT_POLICY_JSON = readFileSync(
  resolve("config/research/follower-strategy-verdict-policy-v1.json"),
  "utf8",
);
const CONTEXT: CopyabilityEvaluationContext = {
  window: { fromMs: WINDOW.windowStartMs, toMs: WINDOW.windowEndMs },
  source: "phase-0a-fixture",
  mode: "PAPER",
  copyRatioBps: 10_000,
  riskPolicyVersion: "RISK_TEST_V1",
  fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
  accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
  copyabilityDefinitionVersion: "COPYABILITY_V1",
};

function emptySnapshot(): HistoricalEvaluationV2EvidenceSnapshot {
  return {
    provenance: {
      resolvedDatabasePath: "/machine-specific/fixture.sqlite",
      observedSchemaMigrations: [
        { version: "0001_fixture.sql", checksum: "sha256:fixture" },
      ],
      requestedWindow: { ...WINDOW },
      expectedContext: { ...CONTEXT, window: { ...CONTEXT.window } },
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

function application(
  fillId: string,
  overrides: Partial<DetailedFollowerFillApplicationEvidence> = {},
): DetailedFollowerFillApplicationEvidence {
  return {
    fillId,
    followerWallet: "follower-wallet",
    leaderWallet: "leader-wallet",
    tokenMint: "TOKEN_A",
    quoteMint: "SOL_NATIVE",
    positionId: 10,
    side: "BUY",
    transition: "OPEN",
    inputAmountRaw: 900_719_925_474_099_300_000n,
    outputAmountRaw: 100n,
    quantityBeforeRaw: 0n,
    quantityAfterRaw: 100n,
    allocatedCostBasisRaw: 0n,
    proceedsRaw: 0n,
    realizedPnlDeltaRaw: 0n,
    positionVersionAfter: 1,
    quoteTimestampMs: 1_500,
    ...overrides,
  };
}

function opportunity(
  executionKey: string,
): StrategyEvaluationOpportunityProjection {
  return {
    executionKey,
    followerWallet: "follower-wallet",
    leaderWallet: "leader-wallet",
    quoteMint: "SOL_NATIVE",
    side: "BUY",
    leaderTradeId: `leader-trade-${executionKey}`,
    sourceTimestamp: {
      valueMs: 2_000,
      precision: "MILLISECOND",
      provenance: "CHAIN_BLOCK_TIME",
    },
    normalizedEvidence: {
      executionKey,
      jupiterAttempts: [{ executionKey, httpStatus: 503, schemaValid: false }],
    },
  };
}

function richSnapshot(): HistoricalEvaluationV2EvidenceSnapshot {
  const open = application("fill-open");
  const reduce = application("fill-reduce", {
    side: "SELL",
    transition: "REDUCE",
    inputAmountRaw: 40n,
    outputAmountRaw: 360_287_970_189_639_720_010n,
    quantityBeforeRaw: 100n,
    quantityAfterRaw: 60n,
    allocatedCostBasisRaw: 360_287_970_189_639_720_000n,
    proceedsRaw: 360_287_970_189_639_720_010n,
    realizedPnlDeltaRaw: 10n,
    positionVersionAfter: 2,
    quoteTimestampMs: 2_500,
  });
  const close = application("fill-close", {
    side: "SELL",
    transition: "CLOSE",
    inputAmountRaw: 60n,
    outputAmountRaw: 540_431_955_284_459_580_017n,
    quantityBeforeRaw: 60n,
    quantityAfterRaw: 0n,
    allocatedCostBasisRaw: 540_431_955_284_459_580_000n,
    proceedsRaw: 540_431_955_284_459_580_017n,
    realizedPnlDeltaRaw: 17n,
    positionVersionAfter: 3,
    quoteTimestampMs: 3_500,
  });
  const snapshot = emptySnapshot();
  return {
    ...snapshot,
    roundTripApplications: [close, open, reduce],
    roundTripApplicationSources: [close, open, reduce].map((item) => ({
      fillId: item.fillId,
      executionKey: `execution-${item.fillId}`,
      leaderTradeId: `leader-trade-${item.fillId}`,
      sourceTimestamp: {
        valueMs: item.quoteTimestampMs,
        precision: "MILLISECOND",
        provenance: "CHAIN_BLOCK_TIME",
      },
    })),
    paperFills: [
      {
        id: "fill-close",
        intentId: "execution-fill-close",
        leaderWallet: "leader-wallet",
        followerWallet: "follower-wallet",
        side: "SELL",
        inputMint: "TOKEN_A",
        outputMint: "SOL_NATIVE",
        feeEvidence: {
          status: "AVAILABLE",
          feeMint: "SOL_NATIVE",
          feeAmountRaw: 0n,
        },
        provider: "JUPITER_SWAP_V2_ORDER",
        fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      },
      {
        id: "fill-open",
        intentId: "execution-fill-open",
        leaderWallet: "leader-wallet",
        followerWallet: "follower-wallet",
        side: "BUY",
        inputMint: "SOL_NATIVE",
        outputMint: "TOKEN_A",
        feeEvidence: {
          status: "AVAILABLE",
          feeMint: "SOL_NATIVE",
          feeAmountRaw: 0n,
        },
        provider: "JUPITER_SWAP_V2_ORDER",
        fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      },
      {
        id: "fill-reduce",
        intentId: "execution-fill-reduce",
        leaderWallet: "leader-wallet",
        followerWallet: "follower-wallet",
        side: "SELL",
        inputMint: "TOKEN_A",
        outputMint: "SOL_NATIVE",
        feeEvidence: {
          status: "AVAILABLE",
          feeMint: "SOL_NATIVE",
          feeAmountRaw: 0n,
        },
        provider: "JUPITER_SWAP_V2_ORDER",
        fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      },
    ],
    opportunities: [opportunity("jupiter-no-route")],
  };
}

function reportOptions() {
  return {
    repositoryCommit: "f073b759172fa84338b26a7d52eca4a996616268",
    buckets: [
      {
        followerWallet: "follower-wallet",
        leaderWallet: "leader-wallet",
        quoteMint: "SOL_NATIVE",
      },
    ],
    historicalEvaluationPolicyInputs: {
      definitionVersion: "STRATEGY_METRICS_V1",
      minimumCompletedCycles: 20,
    },
    failureTaxonomyPolicy: {
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    },
    temporalBlockCount: 4,
    followerStrategyVerdictPolicyJson: VERDICT_POLICY_JSON,
  } as const;
}

describe("buildDeterministicEvidenceReport", () => {
  it("fails closed before building an Artifact when policy identity mismatches", () => {
    expect(() =>
      buildDeterministicEvidenceReport(emptySnapshot(), {
        ...reportOptions(),
        followerStrategyVerdictPolicyJson: VERDICT_POLICY_JSON.replace(
          "30",
          "31",
        ),
      }),
    ).toThrowError("POLICY_IDENTITY_MISMATCH");
  });

  it("binds the approved policy and keeps Leader economics unavailable", () => {
    const report = buildDeterministicEvidenceReport(
      emptySnapshot(),
      reportOptions(),
    );

    expect(report.evaluations[0]).toMatchObject({
      sample: { sampleStatus: "INSUFFICIENT_SAMPLE" },
      historicalEvaluationPolicyInputs: {
        definitionVersion: "STRATEGY_METRICS_V1",
        minimumCompletedCycles: 20,
      },
      verdictPolicy: {
        policyVersion: "FOLLOWER_STRATEGY_VERDICT_POLICY_V1",
        policySha256:
          "sha256:ad40550c95655c73939ee6496ea4221b2345500f813aaf72b2624d78dbda3805",
      },
      leaderMetrics: {
        status: "UNAVAILABLE",
        unavailableReason: "LEADER_ECONOMIC_EVIDENCE_UNAVAILABLE",
        metrics: null,
      },
      verdict: {
        status: "AVAILABLE",
        value: "INSUFFICIENT_EVIDENCE",
        reasonCode: "REQUIRED_BLOCKING_EVIDENCE_UNAVAILABLE",
        policyVersion: "FOLLOWER_STRATEGY_VERDICT_POLICY_V1",
      },
    });

    const json = serializeDeterministicEvidenceReport(report);
    expect(json).not.toContain("POSITIVE_CANDIDATE");
    expect(json).not.toContain("NEGATIVE_EXPECTANCY");
    expect(json).not.toContain("/machine-specific/fixture.sqlite");
  });

  it("produces identical bytes for reordered evidence and buckets", () => {
    const evidence = richSnapshot();
    const secondBucket = {
      followerWallet: "follower-wallet",
      leaderWallet: "leader-z",
      quoteMint: "SOL_NATIVE",
    } as const;
    const options = {
      ...reportOptions(),
      buckets: [secondBucket, ...reportOptions().buckets],
    };
    const reversed = {
      ...evidence,
      roundTripApplications: [...evidence.roundTripApplications].reverse(),
      roundTripApplicationSources: [
        ...evidence.roundTripApplicationSources,
      ].reverse(),
      paperFills: [...evidence.paperFills].reverse(),
      opportunities: [...evidence.opportunities].reverse(),
    };

    const first = serializeDeterministicEvidenceReport(
      buildDeterministicEvidenceReport(evidence, options),
    );
    const second = serializeDeterministicEvidenceReport(
      buildDeterministicEvidenceReport(reversed, {
        ...options,
        buckets: [...options.buckets].reverse(),
      }),
    );

    expect(second).toBe(first);
  });

  it("produces identical bytes for reordered schema migration evidence", () => {
    const firstSnapshot = emptySnapshot();
    const migrations = [
      ...firstSnapshot.provenance.observedSchemaMigrations,
      { version: "0002_fixture.sql", checksum: "sha256:fixture-2" },
    ];
    const secondSnapshot = {
      ...firstSnapshot,
      provenance: {
        ...firstSnapshot.provenance,
        observedSchemaMigrations: [...migrations].reverse(),
      },
    };

    const first = serializeDeterministicEvidenceReport(
      buildDeterministicEvidenceReport(
        {
          ...firstSnapshot,
          provenance: {
            ...firstSnapshot.provenance,
            observedSchemaMigrations: migrations,
          },
        },
        reportOptions(),
      ),
    );
    const second = serializeDeterministicEvidenceReport(
      buildDeterministicEvidenceReport(secondSnapshot, reportOptions()),
    );

    expect(second).toBe(first);
    expect(
      JSON.parse(first).provenance.observedSchemaMigrations.map(
        ({ version }: { version: string }) => version,
      ),
    ).toEqual(["0001_fixture.sql", "0002_fixture.sql"]);
  });

  it("preserves partial SELL weighted-cost precision and failure separation", () => {
    const report = buildDeterministicEvidenceReport(
      richSnapshot(),
      reportOptions(),
    );
    const evaluation = report.evaluations[0]!;

    expect(evaluation.followerMetrics.netQuoteExpectancy).toMatchObject({
      value: "27",
      sampleCount: 1,
      status: "AVAILABLE",
    });
    expect(evaluation.costCompleteness).toMatchObject({
      status: "COST_COMPLETE",
      evaluatedLifecycleCount: 1,
    });
    expect(evaluation.failureTaxonomy.summary).toMatchObject({
      terminalFailureCount: 1,
      categoryCounts: { EXECUTION_FAILURE: 1 },
    });
    expect(evaluation.followerMetrics.netQuoteExpectancy.sampleCount).toBe(1);
    expect(evaluation.sample.sampleStatus).toBe("INSUFFICIENT_SAMPLE");
    expect(evaluation.verdict).toMatchObject({
      status: "AVAILABLE",
      reasonCode: "VERDICT_SAMPLE_BELOW_MINIMUM",
      value: "INSUFFICIENT_EVIDENCE",
    });
    expect(serializeDeterministicEvidenceReport(report)).toContain(
      "900719925474099300000",
    );
  });

  it("changes artifact identity when provenance or definitions change", () => {
    const baseline = buildDeterministicEvidenceReport(
      emptySnapshot(),
      reportOptions(),
    );
    const changedRepository = buildDeterministicEvidenceReport(
      emptySnapshot(),
      { ...reportOptions(), repositoryCommit: "another-commit" },
    );
    const changedPolicy = buildDeterministicEvidenceReport(emptySnapshot(), {
      ...reportOptions(),
      historicalEvaluationPolicyInputs: {
        definitionVersion: "STRATEGY_METRICS_V2",
        minimumCompletedCycles: 20,
      },
    });
    const baselineSnapshot = emptySnapshot();
    const changedSchema = {
      ...baselineSnapshot,
      provenance: {
        ...baselineSnapshot.provenance,
        observedSchemaMigrations: [
          { version: "0002_fixture.sql", checksum: "sha256:changed" },
        ],
      },
    };
    const changedSnapshot = buildDeterministicEvidenceReport(
      changedSchema,
      reportOptions(),
    );

    expect(
      new Set([
        baseline.artifactId,
        changedRepository.artifactId,
        changedPolicy.artifactId,
        changedSnapshot.artifactId,
      ]).size,
    ).toBe(4);
    expect(changedPolicy.provenance.sourceDbIdentity).toBe(
      baseline.provenance.sourceDbIdentity,
    );
    expect(changedRepository.provenance.sourceDbIdentity).toBe(
      baseline.provenance.sourceDbIdentity,
    );
    expect(changedSnapshot.provenance.sourceDbIdentity).not.toBe(
      baseline.provenance.sourceDbIdentity,
    );
  });

  it("renders Markdown only from canonical statuses without converting null to zero", () => {
    const report = buildDeterministicEvidenceReport(
      emptySnapshot(),
      reportOptions(),
    );
    const markdown = renderDeterministicEvidenceReportMarkdown(report);

    expect(markdown).toContain("# Deterministic Evidence Report V1");
    expect(markdown).toContain("## Evaluation: leader-wallet / SOL_NATIVE");
    expect(markdown).toContain(
      "Leader economics | UNAVAILABLE | LEADER_ECONOMIC_EVIDENCE_UNAVAILABLE",
    );
    expect(markdown).toContain(
      "Verdict | AVAILABLE | REQUIRED_BLOCKING_EVIDENCE_UNAVAILABLE",
    );
    expect(markdown).toContain(
      "Net quote expectancy | NO_TRADES | UNAVAILABLE",
    );
    expect(markdown).not.toContain("Net quote expectancy | NO_TRADES | 0");
    expect(markdown).toContain("### Failure Taxonomy");
    expect(markdown).toContain("### Limitations");
    expect(markdown).not.toContain("POSITIVE_CANDIDATE");
    expect(markdown).not.toContain("NEGATIVE_EXPECTANCY");
  });

  it("preserves open-cycle censoring without creating a realized trade", () => {
    const rich = richSnapshot();
    const openOnly = {
      ...rich,
      roundTripApplications: rich.roundTripApplications.filter(
        ({ fillId }) => fillId === "fill-open",
      ),
      roundTripApplicationSources: rich.roundTripApplicationSources.filter(
        ({ fillId }) => fillId === "fill-open",
      ),
      paperFills: rich.paperFills.filter(({ id }) => id === "fill-open"),
      opportunities: [],
    };
    const evaluation = buildDeterministicEvidenceReport(
      openOnly,
      reportOptions(),
    ).evaluations[0]!;

    expect(evaluation.sample).toMatchObject({
      fullyContainedCount: 0,
      rightCensoredCount: 1,
    });
    expect(evaluation.followerCycles.completed).toEqual([]);
    expect(evaluation.followerMetrics.netQuoteExpectancy).toMatchObject({
      value: null,
      status: "NO_TRADES",
      sampleCount: 0,
    });
    expect(evaluation.costCompleteness.status).toBe("NO_EVALUABLE_LIFECYCLES");
  });

  it("excludes machine-specific database paths from canonical identity and bytes", () => {
    const firstSnapshot = emptySnapshot();
    const secondSnapshot = {
      ...firstSnapshot,
      provenance: {
        ...firstSnapshot.provenance,
        resolvedDatabasePath: "/another-machine/copy-trading.sqlite",
      },
    };
    const first = buildDeterministicEvidenceReport(
      firstSnapshot,
      reportOptions(),
    );
    const second = buildDeterministicEvidenceReport(
      secondSnapshot,
      reportOptions(),
    );

    expect(second.provenance.sourceDbIdentity).toBe(
      first.provenance.sourceDbIdentity,
    );
    expect(serializeDeterministicEvidenceReport(second)).toBe(
      serializeDeterministicEvidenceReport(first),
    );
  });
});
