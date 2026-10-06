import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExecutionMode } from "../src/domain/execution.js";
import type { CopyabilityBucket } from "../src/strategy-evaluation/copyability.js";
import { runDeterministicEvidenceReport } from "../src/strategy-evaluation/evidence-report-workflow.js";
import type { ShadowPaperEvidenceBinding } from "../src/strategy-evaluation/read-model.js";

interface EvaluationRequestFile {
  readonly databasePath: string;
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
  const mode = requiredString(object, "mode");
  if (mode !== "PAPER" && mode !== "SHADOW") {
    throw new Error("INVALID_EVALUATION_REQUEST:mode");
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
    databasePath: requiredString(object, "databasePath"),
    outputDirectory: requiredString(object, "outputDirectory"),
    repositoryCommit: requiredString(object, "repositoryCommit"),
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

const [requestPath] = process.argv.slice(2);
if (requestPath === undefined) {
  throw new Error("Usage: evaluate:strategies <evaluation-request.json>");
}

const request = parseRequest(
  JSON.parse(await readFile(resolve(requestPath), "utf8")) as unknown,
);
const followerStrategyVerdictPolicyJson = await readFile(
  resolve("config/research/follower-strategy-verdict-policy-v1.json"),
  "utf8",
);
const window = {
  windowStartMs: request.windowStartMs,
  windowEndMs: request.windowEndMs,
};
const result = await runDeterministicEvidenceReport({
  databasePath: resolve(request.databasePath),
  outputDirectory: resolve(request.outputDirectory),
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
    : {
        shadowPaperEvidenceBinding: request.shadowPaperEvidenceBinding,
      }),
  buckets: request.buckets,
  historicalEvaluationPolicyInputs: request.historicalEvaluationPolicyInputs,
  failureTaxonomyPolicy: {
    definitionVersion: request.failureTaxonomyDefinitionVersion,
  },
  temporalBlockCount: request.temporalBlockCount,
  followerStrategyVerdictPolicyJson,
});

const verdict = result.report.evaluations[0]?.verdict;

process.stdout.write(
  `${JSON.stringify({
    artifactId: result.report.artifactId,
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
    verdictStatus: verdict?.status ?? "NO_EVALUATION",
    verdictValue: verdict?.value ?? null,
    verdictReason: verdict?.reasonCode ?? "NO_EVALUATION",
  })}\n`,
);
