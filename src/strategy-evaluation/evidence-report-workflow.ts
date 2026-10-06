import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildDeterministicEvidenceReport,
  renderDeterministicEvidenceReportMarkdown,
  serializeDeterministicEvidenceReport,
  type BuildDeterministicEvidenceReportOptions,
  type DeterministicEvidenceReport,
} from "./evidence-report.js";
import {
  StrategyEvaluationReadModel,
  type StrategyEvaluationReadSnapshotRequest,
} from "./read-model.js";

export interface RunDeterministicEvidenceReportRequest
  extends
    StrategyEvaluationReadSnapshotRequest,
    BuildDeterministicEvidenceReportOptions {
  readonly outputDirectory: string;
}

export interface DeterministicEvidenceReportArtifacts {
  readonly report: DeterministicEvidenceReport;
  readonly json: string;
  readonly markdown: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
}

function requireOutputDirectory(outputDirectory: unknown): string {
  if (typeof outputDirectory !== "string" || outputDirectory.trim() === "") {
    throw new Error("OUTPUT_DIRECTORY_REQUIRED");
  }
  return resolve(outputDirectory);
}

export async function runDeterministicEvidenceReport(
  request: RunDeterministicEvidenceReportRequest,
): Promise<DeterministicEvidenceReportArtifacts> {
  const outputDirectory = requireOutputDirectory(request.outputDirectory);
  const snapshot = new StrategyEvaluationReadModel().readSnapshot({
    databasePath: request.databasePath,
    window: request.window,
    expectedContext: request.expectedContext,
    ...(request.shadowPaperEvidenceBinding === undefined
      ? {}
      : {
          shadowPaperEvidenceBinding: request.shadowPaperEvidenceBinding,
        }),
  });
  const report = buildDeterministicEvidenceReport(snapshot, {
    repositoryCommit: request.repositoryCommit,
    buckets: request.buckets,
    historicalEvaluationPolicyInputs: request.historicalEvaluationPolicyInputs,
    failureTaxonomyPolicy: request.failureTaxonomyPolicy,
    temporalBlockCount: request.temporalBlockCount,
    followerStrategyVerdictPolicyJson:
      request.followerStrategyVerdictPolicyJson,
  });
  const json = serializeDeterministicEvidenceReport(report);
  const markdown = renderDeterministicEvidenceReportMarkdown(report);
  const jsonPath = resolve(outputDirectory, "evidence-report-v1.json");
  const markdownPath = resolve(outputDirectory, "evidence-report-v1.md");

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, json, "utf8"),
    writeFile(markdownPath, markdown, "utf8"),
  ]);

  return { report, json, markdown, jsonPath, markdownPath };
}
