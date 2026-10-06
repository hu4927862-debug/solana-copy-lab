import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionMode } from "../src/domain/execution.js";
import { jsonStringify } from "../src/domain/json.js";
import type { CopyabilityBucket } from "../src/strategy-evaluation/copyability.js";
import { runDeterministicEvidenceReport } from "../src/strategy-evaluation/evidence-report-workflow.js";
import type { ShadowPaperEvidenceBinding } from "../src/strategy-evaluation/read-model.js";

export interface EvaluationRequestFile {
  readonly schema: "OFFLINE_EVALUATION_REQUEST_V1";
  readonly databasePath: string;
  readonly databaseSha256: string;
  readonly evidenceKind:
    "SYNTHETIC" | "PAPER_SNAPSHOT" | "SHADOW_PAPER_SNAPSHOT";
  readonly outputDirectory: string;
  readonly repositoryCommit: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly source: string;
  readonly mode: ExecutionMode;
  readonly copyRatioBps: number;
  readonly riskPolicyVersion: string;
  readonly fillPolicyVersion: string;
  readonly accountingPolicyVersion: string;
  readonly copyabilityDefinitionVersion: string;
  readonly buckets: readonly CopyabilityBucket[];
  readonly historicalEvaluationPolicyInputs: {
    readonly definitionVersion: string;
    readonly minimumCompletedCycles: number;
  };
  readonly failureTaxonomyDefinitionVersion: string;
  readonly temporalBlockCount: number;
  readonly shadowPaperEvidenceBinding?: ShadowPaperEvidenceBinding;
}

function requiredString(
  object: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = object[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`INVALID_EVALUATION_REQUEST:${field}`);
  }
  return value;
}

function safeInteger(
  object: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = object[field];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`INVALID_EVALUATION_REQUEST:${field}`);
  }
  return value as number;
}

function parseBucket(value: unknown, index: number): CopyabilityBucket {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`INVALID_EVALUATION_REQUEST:buckets[${index}]`);
  }
  const object = value as Readonly<Record<string, unknown>>;
  return {
    followerWallet: requiredString(object, "followerWallet"),
    leaderWallet: requiredString(object, "leaderWallet"),
    quoteMint: requiredString(object, "quoteMint"),
  };
}

function parseShadowPaperEvidenceBinding(
  value: unknown,
): ShadowPaperEvidenceBinding | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_EVALUATION_REQUEST:shadowPaperEvidenceBinding");
  }
  return value as ShadowPaperEvidenceBinding;
}

function parseRequest(value: unknown): EvaluationRequestFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_EVALUATION_REQUEST");
  }
  const object = value as Readonly<Record<string, unknown>>;
  if (object.schema !== "OFFLINE_EVALUATION_REQUEST_V1") {
    throw new Error("INVALID_EVALUATION_REQUEST:schema");
  }
  const databaseSha256 = requiredString(object, "databaseSha256");
  if (!/^[0-9a-f]{64}$/.test(databaseSha256)) {
    throw new Error("INVALID_EVALUATION_REQUEST:databaseSha256");
  }
  const repositoryCommit = requiredString(object, "repositoryCommit");
  if (!/^[0-9a-f]{40}$/.test(repositoryCommit)) {
    throw new Error("INVALID_EVALUATION_REQUEST:repositoryCommit");
  }
  const mode = requiredString(object, "mode");
  if (mode !== "PAPER" && mode !== "SHADOW") {
    throw new Error("INVALID_EVALUATION_REQUEST:mode");
  }
  const evidenceKind = requiredString(object, "evidenceKind");
  if (!(
    (mode === "PAPER" &&
      (evidenceKind === "SYNTHETIC" || evidenceKind === "PAPER_SNAPSHOT")) ||
    (mode === "SHADOW" && evidenceKind === "SHADOW_PAPER_SNAPSHOT")
  )) {
    throw new Error("INVALID_EVALUATION_REQUEST:evidenceKind");
  }
  const buckets = object.buckets;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new Error("INVALID_EVALUATION_REQUEST:buckets");
  }
  const policy = object.historicalEvaluationPolicyInputs;
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error(
      "INVALID_EVALUATION_REQUEST:historicalEvaluationPolicyInputs",
    );
  }
  const policyObject = policy as Readonly<Record<string, unknown>>;
  return {
    schema: "OFFLINE_EVALUATION_REQUEST_V1",
    databasePath: requiredString(object, "databasePath"),
    databaseSha256,
    evidenceKind: evidenceKind as EvaluationRequestFile["evidenceKind"],
    outputDirectory: requiredString(object, "outputDirectory"),
    repositoryCommit,
    windowStartMs: safeInteger(object, "windowStartMs"),
    windowEndMs: safeInteger(object, "windowEndMs"),
    source: requiredString(object, "source"),
    mode,
    copyRatioBps: safeInteger(object, "copyRatioBps"),
    riskPolicyVersion: requiredString(object, "riskPolicyVersion"),
    fillPolicyVersion: requiredString(object, "fillPolicyVersion"),
    accountingPolicyVersion: requiredString(object, "accountingPolicyVersion"),
    copyabilityDefinitionVersion: requiredString(
      object,
      "copyabilityDefinitionVersion",
    ),
    buckets: buckets.map(parseBucket),
    historicalEvaluationPolicyInputs: {
      definitionVersion: requiredString(policyObject, "definitionVersion"),
      minimumCompletedCycles: safeInteger(
        policyObject,
        "minimumCompletedCycles",
      ),
    },
    failureTaxonomyDefinitionVersion: requiredString(
      object,
      "failureTaxonomyDefinitionVersion",
    ),
    temporalBlockCount: safeInteger(object, "temporalBlockCount"),
    ...(object.shadowPaperEvidenceBinding === undefined
      ? {}
      : {
          shadowPaperEvidenceBinding: parseShadowPaperEvidenceBinding(
            object.shadowPaperEvidenceBinding,
          )!,
        }),
  };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function rejectUncommittedSidecars(databasePath: string): Promise<void> {
  for (const suffix of ["-wal", "-journal"]) {
    try {
      const state = await lstat(`${databasePath}${suffix}`);
      if (!state.isFile() || state.size !== 0) {
        throw new Error(`DATABASE_SIDECAR_NOT_EMPTY:${suffix}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function runOfflineEvaluation(requestPath: string) {
  // No provider, collector, signer or live runtime is created by this entrypoint.
  const resolvedRequestPath = resolve(requestPath);
  const requestBytes = await readFile(resolvedRequestPath);
  const request = parseRequest(
    JSON.parse(requestBytes.toString("utf8")) as unknown,
  );
  const databasePath = resolve(
    dirname(resolvedRequestPath),
    request.databasePath,
  );
  const outputDirectory = resolve(
    dirname(resolvedRequestPath),
    request.outputDirectory,
  );
  const databaseState = await lstat(databasePath);
  if (!databaseState.isFile())
    throw new Error("DATABASE_PATH_NOT_REGULAR_FILE");
  await rejectUncommittedSidecars(databasePath);
  const databaseBytes = await readFile(databasePath);
  if (sha256(databaseBytes) !== request.databaseSha256) {
    throw new Error("DATABASE_SHA256_MISMATCH");
  }
  await rejectUncommittedSidecars(databasePath);
  const followerStrategyVerdictPolicyJson = await readFile(
    resolve(root, "config/research/follower-strategy-verdict-policy-v1.json"),
    "utf8",
  );
  const entrypointSha256 = sha256(
    await readFile(fileURLToPath(import.meta.url)),
  );
  try {
    await mkdir(outputDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("OUTPUT_DIRECTORY_ALREADY_EXISTS");
    }
    throw error;
  }
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "solana-copy-lab-evaluation-"),
  );
  try {
    // The evaluator reads only the exact buffer validated above. It never opens
    // the source database and therefore cannot checkpoint or create its sidecars.
    const snapshotPath = resolve(temporaryDirectory, "snapshot.sqlite");
    await writeFile(snapshotPath, databaseBytes, { flag: "wx", mode: 0o600 });
    const window = {
      windowStartMs: request.windowStartMs,
      windowEndMs: request.windowEndMs,
    };
    const report = await runDeterministicEvidenceReport({
      databasePath: snapshotPath,
      outputDirectory,
      repositoryCommit: request.repositoryCommit,
      window,
      expectedContext: {
        window: { fromMs: window.windowStartMs, toMs: window.windowEndMs },
        source: request.source,
        mode: request.mode,
        copyRatioBps: request.copyRatioBps,
        riskPolicyVersion: request.riskPolicyVersion,
        fillPolicyVersion: request.fillPolicyVersion,
        accountingPolicyVersion: request.accountingPolicyVersion,
        copyabilityDefinitionVersion: request.copyabilityDefinitionVersion,
      },
      ...(request.shadowPaperEvidenceBinding === undefined
        ? {}
        : { shadowPaperEvidenceBinding: request.shadowPaperEvidenceBinding }),
      buckets: request.buckets,
      historicalEvaluationPolicyInputs:
        request.historicalEvaluationPolicyInputs,
      failureTaxonomyPolicy: {
        definitionVersion: request.failureTaxonomyDefinitionVersion,
      },
      temporalBlockCount: request.temporalBlockCount,
      followerStrategyVerdictPolicyJson,
    });
    await rejectUncommittedSidecars(databasePath);
    if (sha256(await readFile(databasePath)) !== request.databaseSha256) {
      throw new Error("SOURCE_DATABASE_CHANGED_DURING_EVALUATION");
    }
    const summary = {
      schema: "OFFLINE_EVALUATION_RESULT_V1",
      evidenceKind: request.evidenceKind,
      databaseSha256: request.databaseSha256,
      requestSha256: sha256(requestBytes),
      entrypointSha256,
      declaredSourceCommit: request.repositoryCommit,
      artifactId: report.report.artifactId,
      sourceRows: report.report.provenance.sourceRowCounts,
      evaluations: report.report.evaluations.map((evaluation) => ({
        bucket: evaluation.bucket,
        availability: evaluation.availability,
        sample: evaluation.sample,
        verdict: evaluation.verdict,
        costCompleteness: evaluation.costCompleteness,
        failureTaxonomy: evaluation.failureTaxonomy.summary,
        executionQuality: evaluation.executionQuality,
        copyabilityComponents: evaluation.copyabilityComponents,
      })),
      unknownLiveCosts: {
        networkFee: "UNKNOWN",
        tip: "UNKNOWN",
        actualFillDeviation: "UNKNOWN",
      },
      limitations: [
        "Evidence kind and source commit are caller declarations, not independent provenance proof.",
        "Entrypoint hash does not attest the complete evaluator dependency closure.",
        "A paper verdict is not alpha validation, finalized real net PnL or execution qualification.",
        "Paper cost completeness does not establish actual network fees, tips or fill deviation.",
        "A stable validated copy is evaluated; this is not live database concurrency isolation.",
      ],
      alphaValidated: false,
      executionQualified: false,
      fundsAuthorized: false,
      sourceDatabaseUnchanged: true,
    };
    const summaryPath = resolve(outputDirectory, "SUMMARY.json");
    await writeFile(summaryPath, `${jsonStringify(summary, 2)}\n`, {
      flag: "wx",
    });
    const manifestPath = resolve(outputDirectory, "MANIFEST.json");
    const files = await Promise.all(
      ["SUMMARY.json", "evidence-report-v1.json", "evidence-report-v1.md"].map(
        async (path) => ({
          path,
          sha256: sha256(await readFile(resolve(outputDirectory, path))),
        }),
      ),
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schema: "OFFLINE_EVALUATION_MANIFEST_V1",
          evidenceKind: request.evidenceKind,
          databaseSha256: request.databaseSha256,
          requestSha256: summary.requestSha256,
          entrypointSha256,
          artifactId: report.report.artifactId,
          files,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    return { outputDirectory, summary, report, manifestPath };
  } finally {
    // Only the private directory allocated by this invocation is removed.
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === undefined) {
    process.stderr.write(
      "Usage: evaluate:strategies <evaluation-request.json>\n",
    );
    process.exitCode = 1;
  } else {
    runOfflineEvaluation(args[0])
      .then(({ outputDirectory, summary, report, manifestPath }) => {
        process.stdout.write(
          `${jsonStringify(
            {
              ...summary,
              outputDirectory,
              jsonPath: report.jsonPath,
              markdownPath: report.markdownPath,
              manifestPath,
            },
            2,
          )}\n`,
        );
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      });
  }
}
