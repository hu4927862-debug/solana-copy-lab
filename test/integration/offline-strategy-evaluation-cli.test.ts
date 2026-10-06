import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runPaperWorkflow } from "../../scripts/demo-paper-workflow.js";
import { runOfflineEvaluation } from "../../scripts/evaluate-strategies.js";

const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

let fixtureDirectory: string;
let originalRequest: Record<string, unknown>;

beforeAll(async () => {
  const result = await runPaperWorkflow();
  fixtureDirectory = result.outputDirectory;
  const generatedPath = resolve(fixtureDirectory, "EVALUATION-REQUEST.json");
  if (existsSync(generatedPath)) {
    originalRequest = JSON.parse(readFileSync(generatedPath, "utf8")) as Record<
      string,
      unknown
    >;
  } else {
    // Source archives have no Git identity. Test-only provenance is explicitly
    // SYNTHETIC; the actual demo must not invent a commit or usable request.
    const evaluation = result.report.report.evaluations[0]!;
    const context =
      evaluation.leaderComparability.historicalReference.evaluationContext;
    originalRequest = {
      schema: "OFFLINE_EVALUATION_REQUEST_V1",
      databasePath: "./paper.sqlite",
      databaseSha256: sha256(resolve(fixtureDirectory, "paper.sqlite")),
      evidenceKind: "SYNTHETIC",
      outputDirectory: "./re-evaluated",
      repositoryCommit: "a".repeat(40), // SYNTHETIC_TEST_SOURCE_COMMIT, not a release
      ...result.report.report.evidenceWindow,
      source: context.source,
      mode: context.mode,
      copyRatioBps: context.copyRatioBps,
      riskPolicyVersion: context.riskPolicyVersion,
      fillPolicyVersion: context.fillPolicyVersion,
      accountingPolicyVersion: context.accountingPolicyVersion,
      copyabilityDefinitionVersion: context.copyabilityDefinitionVersion,
      buckets: [evaluation.bucket],
      historicalEvaluationPolicyInputs:
        evaluation.historicalEvaluationPolicyInputs,
      failureTaxonomyDefinitionVersion:
        evaluation.failureTaxonomy.definitionVersion,
      temporalBlockCount: 4,
    };
  }
  writeFileSync(
    resolve(fixtureDirectory, "TEST-EVALUATION-REQUEST.json"),
    `${JSON.stringify(originalRequest, null, 2)}\n`,
    { flag: "wx" },
  );
});

function requestFile(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "offline-evaluation-test-"));
  const outputDirectory = resolve(directory, "output");
  const path = resolve(directory, "request.json");
  const request: Record<string, unknown> = {
    ...originalRequest,
    databasePath: resolve(fixtureDirectory, "paper.sqlite"),
    outputDirectory,
    ...overrides,
  };
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`, { flag: "wx" });
  return { path, outputDirectory, request };
}

describe("offline strategy evaluation request CLI", () => {
  it("reuses the real evaluator, retains every bucket and binds outputs without mutating the input", async () => {
    const network = vi.fn(() => {
      throw new Error("NETWORK_FORBIDDEN");
    });
    vi.stubGlobal("fetch", network);
    try {
      const source = resolve(fixtureDirectory, "paper.sqlite");
      const before = sha256(source);
      const firstRequest = requestFile({
        buckets: [
          ...(originalRequest.buckets as object[]),
          {
            followerWallet: "unobserved-synthetic-follower",
            leaderWallet: "unobserved-synthetic-leader",
            quoteMint: "SOL_NATIVE",
          },
        ],
      });
      const first = await runOfflineEvaluation(firstRequest.path);
      const second = await runOfflineEvaluation(
        requestFile({ buckets: firstRequest.request.buckets }).path,
      );
      expect(first.summary.evaluations).toHaveLength(2);
      expect(
        first.summary.evaluations.map((item) => item.verdict.value),
      ).toEqual(["INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE"]);
      expect(first.summary.sourceRows.opportunities).toBe(5);
      expect(first.summary.evaluations[0]?.costCompleteness.status).toBe(
        "COST_INCOMPLETE",
      );
      expect(
        first.summary.evaluations[0]?.failureTaxonomy
          .totalCanonicalOpportunityCount,
      ).toBe(5);
      expect(first.report.report.artifactId).toBe(
        second.report.report.artifactId,
      );
      expect(first.report.json).toBe(second.report.json);
      expect(first.summary.unknownLiveCosts).toEqual({
        networkFee: "UNKNOWN",
        tip: "UNKNOWN",
        actualFillDeviation: "UNKNOWN",
      });
      expect(first.summary.evidenceKind).toBe("SYNTHETIC");
      expect(first.summary.databaseSha256).toBe(before);
      expect(first.summary.requestSha256).toBe(sha256(firstRequest.path));
      expect(sha256(source)).toBe(before);
      expect(network).not.toHaveBeenCalled();
      const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
      expect(manifest.databaseSha256).toBe(before);
      expect(manifest.requestSha256).toBe(sha256(firstRequest.path));
      for (const file of manifest.files) {
        expect(sha256(resolve(firstRequest.outputDirectory, file.path))).toBe(
          file.sha256,
        );
      }
      expect(readdirSync(firstRequest.outputDirectory).sort()).toEqual([
        "MANIFEST.json",
        "SUMMARY.json",
        "evidence-report-v1.json",
        "evidence-report-v1.md",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves database and new output paths relative to the request file", async () => {
    // The demo's generated request already uses a relative database and output.
    const generated = resolve(fixtureDirectory, "TEST-EVALUATION-REQUEST.json");
    expect(originalRequest.databasePath).toBe("./paper.sqlite");
    expect(originalRequest.outputDirectory).toBe("./re-evaluated");
    const result = await runOfflineEvaluation(generated);
    expect(result.outputDirectory).toBe(
      resolve(fixtureDirectory, "re-evaluated"),
    );
    expect(result.summary.databaseSha256).toBe(originalRequest.databaseSha256);
  });

  it("fails hash mismatch before creating any report output", async () => {
    const request = requestFile({ databaseSha256: "0".repeat(64) });
    await expect(runOfflineEvaluation(request.path)).rejects.toThrow(
      "DATABASE_SHA256_MISMATCH",
    );
    expect(existsSync(request.outputDirectory)).toBe(false);
  });

  it.each(["-wal", "-journal"])(
    "refuses a snapshot with a nonempty %s sidecar without touching it",
    async (suffix) => {
      const parent = mkdtempSync(resolve(tmpdir(), "sidecar-evaluation-test-"));
      const databasePath = resolve(parent, "snapshot.sqlite");
      writeFileSync(
        databasePath,
        readFileSync(resolve(fixtureDirectory, "paper.sqlite")),
      );
      const sidecarPath = `${databasePath}${suffix}`;
      writeFileSync(sidecarPath, "UNCOMMITTED_OR_ACTIVE_EVIDENCE");
      const request = requestFile({ databasePath });
      await expect(runOfflineEvaluation(request.path)).rejects.toThrow(
        "DATABASE_SIDECAR_NOT_EMPTY",
      );
      expect(readFileSync(sidecarPath, "utf8")).toBe(
        "UNCOMMITTED_OR_ACTIVE_EVIDENCE",
      );
      expect(existsSync(request.outputDirectory)).toBe(false);
    },
  );

  it("refuses to overwrite an existing report directory", async () => {
    const request = requestFile({ outputDirectory: fixtureDirectory });
    const manifestBefore = sha256(resolve(fixtureDirectory, "MANIFEST.json"));
    await expect(runOfflineEvaluation(request.path)).rejects.toThrow(
      "OUTPUT_DIRECTORY_ALREADY_EXISTS",
    );
    expect(sha256(resolve(fixtureDirectory, "MANIFEST.json"))).toBe(
      manifestBefore,
    );
  });

  it.each([
    [{ schema: "UNKNOWN_SCHEMA" }, "schema"],
    [{ databaseSha256: undefined }, "databaseSha256"],
    [{ repositoryCommit: "REPLACE_WITH_EXACT_GIT_COMMIT" }, "repositoryCommit"],
    [{ mode: "LIVE" }, "mode"],
    [{ evidenceKind: "PAPER_SNAPSHOT", mode: "SHADOW" }, "evidenceKind"],
  ])("rejects invalid request identity %s", async (overrides, field) => {
    const request = requestFile(overrides);
    await expect(runOfflineEvaluation(request.path)).rejects.toThrow(
      `INVALID_EVALUATION_REQUEST:${field}`,
    );
    expect(existsSync(request.outputDirectory)).toBe(false);
  });
});
