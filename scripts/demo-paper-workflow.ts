import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CopyEngine } from "../src/copy/copy-engine.js";
import { TransactionNormalizer } from "../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../src/decoder/swap-classifier.js";
import { PROGRAM_IDS } from "../src/decoder/program-registry.js";
import type { RawTransaction } from "../src/decoder/raw-transaction.js";
import { NATIVE_SOL } from "../src/domain/assets.js";
import { jsonStringify } from "../src/domain/json.js";
import { SystemClock } from "../src/domain/time.js";
import { ExecutionCoordinator } from "../src/execution/execution-coordinator.js";
import type {
  JupiterOrder,
  JupiterOrderProvider,
  JupiterOrderRequest,
} from "../src/execution/jupiter-order-adapter.js";
import { PaperTransactionSender } from "../src/execution/paper-transaction-sender.js";
import { SqliteDatabase } from "../src/persistence/database.js";
import { StateStore } from "../src/persistence/state-store.js";
import { parseRiskPolicy } from "../src/risk/risk-policy.js";
import { runDeterministicEvidenceReport } from "../src/strategy-evaluation/evidence-report-workflow.js";
import {
  FOLLOWER,
  LEADER_A,
  NEGATIVE_FIXTURES,
  TOKEN_MINT,
  swapFixture,
} from "../test/fixtures/mainnet-fixtures.js";
import { envelope } from "../test/helpers/envelope.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tokenRaw = 9_007_199_254_740_993n;
const principalRaw = 10_000_000n;
const policyPath = resolve(root, "config/risk-policy.example.json");
const verdictPolicyPath = resolve(
  root,
  "config/research/follower-strategy-verdict-policy-v1.json",
);
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

// This is an in-memory fixture provider, not the HTTP Jupiter adapter. It has
// no transport, credentials or transaction assembly capability.
class SyntheticQuotes implements JupiterOrderProvider {
  readonly receipts: JupiterOrder[] = [];
  nextCase = "";

  async getOrder(request: JupiterOrderRequest): Promise<JupiterOrder> {
    if (this.receipts.length >= 4) throw new Error("SYNTHETIC_QUOTE_LIMIT");
    const now = Date.now();
    const monotonicNs = process.hrtime.bigint();
    const order: JupiterOrder = {
      requestId: `synthetic-${this.nextCase}`,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputRaw: request.amount,
      expectedOutputRaw:
        request.inputMint === NATIVE_SOL ? tokenRaw : 11_000_000n,
      router: "SYNTHETIC_FIXTURE",
      mode: "paper",
      feeBps: 0,
      feeMint: request.inputMint,
      ...(this.nextCase === "missing-impact-buy"
        ? {}
        : {
            priceImpactPct:
              this.nextCase === "high-impact-buy" ? "2.00" : "0.10",
          }),
      route: [{ provider: "SYNTHETIC_FIXTURE" }],
      requestTimestampMs: now,
      responseTimestampMs: now,
      requestMonotonicNs: monotonicNs,
      responseMonotonicNs: monotonicNs,
      httpStatus: 200,
      schemaValid: true,
      hasAssembledTransaction: false,
    };
    this.receipts.push(order);
    return order;
  }
}

function repositoryHead(): string {
  try {
    const head = readFileSync(resolve(root, ".git/HEAD"), "utf8").trim();
    const value = head.startsWith("ref: ")
      ? readFileSync(resolve(root, ".git", head.slice(5)), "utf8").trim()
      : head;
    return /^[0-9a-f]{40}$/.test(value) ? value : "UNKNOWN_SOURCE_REVISION";
  } catch {
    return "UNKNOWN_SOURCE_REVISION";
  }
}

export async function runPaperWorkflow(
  options: { outputDirectory?: string } = {},
) {
  if (
    (process.env.PAPER_ONLY !== undefined &&
      process.env.PAPER_ONLY !== "true") ||
    (process.env.LIVE_FUNDS_ENABLED !== undefined &&
      process.env.LIVE_FUNDS_ENABLED !== "false") ||
    (process.env.FUNDS_AUTHORIZED !== undefined &&
      process.env.FUNDS_AUTHORIZED !== "NO")
  ) {
    throw new Error("SYNTHETIC_PAPER_SAFETY_CONFIG_INVALID");
  }
  // Claim a NEW directory first. Never open an existing database or delete any
  // user files, even if later fixture assertions fail.
  const outputDirectory =
    options.outputDirectory === undefined
      ? mkdtempSync(resolve(tmpdir(), "solana-copy-lab-paper-"))
      : resolve(options.outputDirectory);
  if (options.outputDirectory !== undefined) {
    if (existsSync(outputDirectory))
      throw new Error("OUTPUT_DIRECTORY_ALREADY_EXISTS");
    try {
      mkdirSync(outputDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("OUTPUT_DIRECTORY_ALREADY_EXISTS");
      throw error;
    }
  }
  const priorPaper = process.env.PAPER_ONLY;
  const priorLive = process.env.LIVE_FUNDS_ENABLED;
  let database: SqliteDatabase | undefined;
  try {
    process.env.PAPER_ONLY = "true";
    process.env.LIVE_FUNDS_ENABLED = "false";
    const startMs = Date.now();
    const clock = new SystemClock();
    const databasePath = resolve(outputDirectory, "paper.sqlite");
    const policy = parseRiskPolicy(
      JSON.parse(readFileSync(policyPath, "utf8")),
    );
    database = new SqliteDatabase({
      path: databasePath,
      migrationsDirectory: resolve(root, "migrations"),
    });
    const store = new StateStore(database, clock, policy);
    const quotes = new SyntheticQuotes();
    const coordinator = new ExecutionCoordinator(
      store,
      new PaperTransactionSender(quotes),
    );
    const classifier = new SwapClassifier();
    const normalizer = new TransactionNormalizer(clock);
    const copy = new CopyEngine();
    const inputs: { name: string; transaction: RawTransaction }[] = [];
    const cases: {
      name: string;
      result: string;
      quoteRequests: number;
      eventId?: string;
      executionKey?: string;
      inputRaw?: string;
      outputRaw?: string;
    }[] = [];
    await store.upsertWallet(LEADER_A, "LEADER", 10_000);
    await store.upsertWallet(FOLLOWER, "FOLLOWER");
    const buy = {
      ...swapFixture({
        name: "public-paper-buy",
        programId: PROGRAM_IDS.JUPITER_V6,
        parsedType: "route",
        side: "BUY",
        quoteRaw: principalRaw,
        tokenRaw,
      }),
      sourceTimestampMs: startMs,
    };
    const makeBuy = (name: string, stale = false) => ({
      ...buy,
      signature: `synthetic-${name}-${buy.signature}`,
      sourceTimestampMs: stale
        ? startMs - policy.maxIntentAgeMs - 1_000
        : startMs,
    });
    const transactions = [
      { name: "paper-buy", transaction: buy },
      { name: "duplicate-buy", transaction: buy },
      { name: "high-impact-buy", transaction: makeBuy("high-impact-buy") },
      {
        name: "missing-impact-buy",
        transaction: makeBuy("missing-impact-buy"),
      },
      { name: "stale-buy", transaction: makeBuy("stale-buy", true) },
      { name: "ordinary-transfer", transaction: NEGATIVE_FIXTURES.splTransfer },
      {
        name: "paper-full-sell",
        transaction: {
          ...swapFixture({
            name: "public-paper-full-sell",
            programId: PROGRAM_IDS.JUPITER_V6,
            parsedType: "route",
            side: "SELL",
            quoteRaw: 11_000_000n,
            tokenRaw,
            preTokenRaw: tokenRaw,
          }),
          sourceTimestampMs: startMs,
        },
      },
    ];
    for (const { name, transaction } of transactions) {
      inputs.push({ name, transaction });
      const classification = classifier.classify(
        normalizer.normalize(envelope(transaction)),
        LEADER_A,
      );
      if (!classification.accepted) {
        cases.push({ name, result: classification.code, quoteRequests: 0 });
        continue;
      }
      const event = classification.event;
      if (!(await store.saveLeaderTrade(event))) {
        cases.push({
          name,
          result: "DUPLICATE_EVENT",
          quoteRequests: 0,
          eventId: event.id,
        });
        continue;
      }
      const intent = copy.decide(
        event,
        { followerWallet: FOLLOWER, copyRatioBps: 10_000, mode: "PAPER" },
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          event.token.mint,
          event.quote.mint,
        ),
      );
      quotes.nextCase = name;
      const before = quotes.receipts.length;
      const result = await coordinator.execute(intent);
      cases.push({
        name,
        result: result?.reason ?? result?.state ?? "DUPLICATE_INTENT",
        quoteRequests: quotes.receipts.length - before,
        eventId: event.id,
        executionKey: intent.executionKey,
        ...(result?.paperQuoteEvidence === undefined
          ? {}
          : {
              inputRaw: result.paperQuoteEvidence.inputAmountRaw.toString(),
              outputRaw: result.paperQuoteEvidence.outputAmountRaw.toString(),
            }),
      });
    }
    const position = store.getPaperPosition(
      FOLLOWER,
      LEADER_A,
      TOKEN_MINT,
      NATIVE_SOL,
    );
    const paperFills = (
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM paper_fills")
        .get() as { count: number }
    ).count;
    database.close();
    const databaseHashBeforeReport = hash(databasePath);
    const endMs = Date.now() + 1;
    const report = await runDeterministicEvidenceReport({
      databasePath,
      outputDirectory: resolve(outputDirectory, "report"),
      repositoryCommit: repositoryHead(),
      window: {
        windowStartMs: startMs - policy.maxIntentAgeMs - 2_000,
        windowEndMs: endMs,
      },
      expectedContext: {
        window: {
          fromMs: startMs - policy.maxIntentAgeMs - 2_000,
          toMs: endMs,
        },
        source: "SYNTHETIC_PUBLIC_DEMO",
        mode: "PAPER",
        copyRatioBps: 10_000,
        riskPolicyVersion: policy.policyVersion,
        fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
        accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
        copyabilityDefinitionVersion: "COPYABILITY_V1",
      },
      buckets: [
        {
          followerWallet: FOLLOWER,
          leaderWallet: LEADER_A,
          quoteMint: NATIVE_SOL,
        },
      ],
      historicalEvaluationPolicyInputs: {
        definitionVersion: "STRATEGY_METRICS_V1",
        minimumCompletedCycles: 20,
      },
      failureTaxonomyPolicy: { definitionVersion: "OPPORTUNITY_FAILURE_V1" },
      temporalBlockCount: 4,
      followerStrategyVerdictPolicyJson: readFileSync(
        verdictPolicyPath,
        "utf8",
      ),
    });
    if (hash(databasePath) !== databaseHashBeforeReport)
      throw new Error("REPORT_MUTATED_DATABASE");
    const verdict = report.report.evaluations[0]?.verdict.value;
    if (verdict !== "INSUFFICIENT_EVIDENCE")
      throw new Error("SYNTHETIC_EVIDENCE_VERDICT_INVALID");
    const summary = {
      schema: "PUBLIC_PAPER_WORKFLOW_V1",
      mode: "SYNTHETIC_OFFLINE_PAPER",
      evidence:
        "All transactions and quote responses are synthetic. Paper ledger PnL is not finalized real net PnL or profitability evidence.",
      sourceRevision: repositoryHead(),
      entrypointSha256: hash(fileURLToPath(import.meta.url)),
      inputs: inputs.length,
      syntheticQuoteRequests: quotes.receipts.length,
      paperFills,
      duplicateEvents: cases.filter((item) => item.result === "DUPLICATE_EVENT")
        .length,
      verdict,
      cases,
      position:
        position === undefined
          ? null
          : {
              quantityRaw: position.quantityRaw.toString(),
              status: position.status,
              totalCostQuoteRaw: position.totalCostQuoteRaw.toString(),
              realizedPnlQuoteRaw: position.realizedPnlQuoteRaw.toString(),
            },
      costEvidence: {
        platformFeeAmount: "UNKNOWN",
        networkFee: "UNKNOWN",
        tip: "UNKNOWN",
        actualFillDeviation: "UNKNOWN",
      },
      riskContract: {
        policyVersion: policy.policyVersion,
        sha256: hash(policyPath),
        buyImpactPercentagePoints:
          policy.maxBuyPriceImpactPctByQuoteMint[NATIVE_SOL],
        sellImpactPercentagePoints:
          policy.maxSellPriceImpactPctByQuoteMint[NATIVE_SOL],
        limitation: "Public Paper risk example, not Money Lane authority.",
      },
      forbiddenEffects: { network: 0, sign: 0, send: 0, funds: 0 },
      fundsAuthorized: false,
      reportDatabaseUnchanged: true,
    };
    const write = (name: string, value: unknown) =>
      writeFileSync(
        resolve(outputDirectory, name),
        `${jsonStringify(value, 2)}\n`,
        { flag: "wx" },
      );
    write("SUMMARY.json", summary);
    write("SYNTHETIC-INPUTS.json", { evidence: "SYNTHETIC", inputs });
    write("SYNTHETIC-QUOTES.json", {
      evidence: "SYNTHETIC",
      receipts: quotes.receipts,
    });
    const files = [
      "SUMMARY.json",
      "SYNTHETIC-INPUTS.json",
      "SYNTHETIC-QUOTES.json",
      "paper.sqlite",
      "report/evidence-report-v1.json",
      "report/evidence-report-v1.md",
      ...["paper.sqlite-shm", "paper.sqlite-wal"].filter((path) =>
        existsSync(resolve(outputDirectory, path)),
      ),
    ];
    write("MANIFEST.json", {
      schema: "PUBLIC_PAPER_WORKFLOW_MANIFEST_V1",
      evidence: "SYNTHETIC",
      files: files.map((path) => ({
        path,
        sha256: hash(resolve(outputDirectory, path)),
      })),
      limitations: [
        "Not a mainnet observation or live authorization.",
        "Provider/fee evidence is a synthetic fixture and cannot qualify a strategy.",
      ],
    });
    return { outputDirectory, summary, report };
  } finally {
    if (database?.sqlite.open) database.close();
    if (priorPaper === undefined) delete process.env.PAPER_ONLY;
    else process.env.PAPER_ONLY = priorPaper;
    if (priorLive === undefined) delete process.env.LIVE_FUNDS_ENABLED;
    else process.env.LIVE_FUNDS_ENABLED = priorLive;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (
    args.length !== 0 &&
    !(args.length === 2 && args[0] === "--output" && args[1])
  ) {
    process.stderr.write(
      "Usage: node --import tsx scripts/demo-paper-workflow.ts [--output <new-directory>]\n",
    );
    process.exitCode = 1;
  } else {
    runPaperWorkflow(args[1] === undefined ? {} : { outputDirectory: args[1] })
      .then(({ outputDirectory, summary }) => {
        process.stdout.write(
          `${JSON.stringify({ outputDirectory, ...summary }, null, 2)}\n`,
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
