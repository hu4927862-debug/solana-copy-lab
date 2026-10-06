import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_SOL } from "../../src/domain/assets.js";
import { runDeterministicEvidenceReport } from "../../src/strategy-evaluation/evidence-report-workflow.js";
import { testStore } from "../helpers/database.js";

const VERDICT_POLICY_JSON = readFileSync(
  resolve("config/research/follower-strategy-verdict-policy-v1.json"),
  "utf8",
);
const APPROVED_SHADOW_PAPER_BINDING = {
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
} as const;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function request(databasePath: string, outputDirectory: string) {
  return {
    databasePath,
    outputDirectory,
    repositoryCommit: "f073b759172fa84338b26a7d52eca4a996616268",
    window: { windowStartMs: 1_000, windowEndMs: 5_000 },
    expectedContext: {
      window: { fromMs: 1_000, toMs: 5_000 },
      source: "phase-0a-integration-fixture",
      mode: "PAPER",
      copyRatioBps: 10_000,
      riskPolicyVersion: "TEST_RISK_V1",
      fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
      copyabilityDefinitionVersion: "COPYABILITY_V1",
    },
    buckets: [
      {
        followerWallet: "follower-wallet",
        leaderWallet: "leader-wallet",
        quoteMint: NATIVE_SOL,
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

describe("runDeterministicEvidenceReport", () => {
  it("reads SQLite without mutation and emits byte-stable JSON and Markdown", async () => {
    const { database, path } = testStore("phase-0a-workflow-");
    database.close();
    const databaseHashBefore = sha256File(path);
    const firstDirectory = mkdtempSync(resolve(tmpdir(), "phase-0a-first-"));
    const secondDirectory = mkdtempSync(resolve(tmpdir(), "phase-0a-second-"));

    const first = await runDeterministicEvidenceReport(
      request(path, firstDirectory),
    );
    const second = await runDeterministicEvidenceReport(
      request(path, secondDirectory),
    );

    expect(second.json).toBe(first.json);
    expect(second.markdown).toBe(first.markdown);
    expect(readFileSync(first.jsonPath, "utf8")).toBe(first.json);
    expect(readFileSync(first.markdownPath, "utf8")).toBe(first.markdown);
    expect(sha256File(path)).toBe(databaseHashBefore);
    expect(first.report.evaluations[0]).toMatchObject({
      leaderMetrics: { status: "UNAVAILABLE", metrics: null },
      verdictPolicy: {
        policyVersion: "FOLLOWER_STRATEGY_VERDICT_POLICY_V1",
        policySha256:
          "sha256:ad40550c95655c73939ee6496ea4221b2345500f813aaf72b2624d78dbda3805",
      },
      verdict: {
        status: "AVAILABLE",
        reasonCode: "REQUIRED_BLOCKING_EVIDENCE_UNAVAILABLE",
        value: "INSUFFICIENT_EVIDENCE",
      },
    });
  });

  it("fails for a missing database without creating it", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "phase-0a-missing-"));
    const missingDatabase = resolve(directory, "missing.sqlite");

    await expect(
      runDeterministicEvidenceReport(
        request(missingDatabase, resolve(directory, "reports")),
      ),
    ).rejects.toThrowError("DATABASE_NOT_FOUND");
    expect(existsSync(missingDatabase)).toBe(false);
  });

  it("binds explicit Shadow Paper qualification into deterministic snapshot provenance", async () => {
    const { database, path } = testStore("phase-0a-shadow-binding-");
    database.close();
    const approvedRequest = {
      ...request(path, "unused"),
      expectedContext: {
        ...request(path, "unused").expectedContext,
        riskPolicyVersion: "PAPER_RISK_V1",
      },
    } as const;
    const unbound = await runDeterministicEvidenceReport({
      ...approvedRequest,
      outputDirectory: mkdtempSync(resolve(tmpdir(), "phase-0a-unbound-")),
    });
    const bound = await runDeterministicEvidenceReport({
      ...approvedRequest,
      outputDirectory: mkdtempSync(resolve(tmpdir(), "phase-0a-bound-")),
      shadowPaperEvidenceBinding: APPROVED_SHADOW_PAPER_BINDING,
    });

    expect(bound.report.provenance.sourceDbIdentity).not.toBe(
      unbound.report.provenance.sourceDbIdentity,
    );
  });
});
