import type { FinalityReceipt } from "./quote-finality.js";
export { FINALITY_SYNC_POLICY } from "./quote-finality.js";
import { verifyCandidateIdentity } from "./candidate.js";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import bs58 from "bs58";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { normalizeJupiterPriceImpact } from "../execution/jupiter-price-impact.js";
import { USDC_MINT, WSOL_MINT } from "../domain/assets.js";
import { associatedAccount, reviewTransaction } from "./transaction-review.js";
import { decodeIndependentAlt } from "./cpi-semantic-evidence.js";
import { JupiterSelfRpcNetwork } from "./self-rpc-network.js";
import { digest } from "./protocol.js";
import { requestFailureCode, type RequestPhase, type NetworkRequestAudit, type LiveOrder, type Simulation, type WalletSnapshot } from "./adapters.js";

const BUDGET = { maxJupiterRequests: 4, maxRpcReadRequests: 21,
  maxSimulationRequests: 2, maxTotalRequests: 27,
  maxTotalDurationSeconds: 300, maxRetries: 0,
  maxAltTablesPerMessage: 1 } as const;
const SCOPE = "SOL_USDC_CLASSIC_SPL_ATA_JUPITER_V1_RAYDIUM_CLMM_V0_FULL_SELL_ONLY";
/** Diagnostic-only bounds from the existing Manual V2 narrow protocol evidence.
 * These cannot authorize capital and do not mutate the funded protocol. */
const LIMITS = { networkFeeCapLamports: "100000", accountRentCapLamports: "3000000",
  exitReserveLamports: "5000000", maxSlippageBps: 50,
  maxPlatformFeeBps: 0, maxPriceImpactPct: "0.5" } as const;
const walletKey = z.string().refine(s => {
  try { return bs58.decode(s).length === 32; } catch { return false; }
}, "WALLET_PUBLIC_KEY_REQUIRED");
export const DiagnosticPreflightRequestSchema = z.object({
  version: z.literal("DIAGNOSTIC_PREFLIGHT_REQUEST_V1"),
  candidateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  walletPublicKey: walletKey,
  diagnosticBuyLamports: z.literal("5000000"),
  scope: z.literal(SCOPE),
  requestBudget: z.object({
    maxJupiterRequests: z.literal(BUDGET.maxJupiterRequests),
    maxRpcReadRequests: z.literal(BUDGET.maxRpcReadRequests),
    maxSimulationRequests: z.literal(BUDGET.maxSimulationRequests),
    maxTotalRequests: z.literal(BUDGET.maxTotalRequests),
    maxTotalDurationSeconds: z.literal(BUDGET.maxTotalDurationSeconds),
    maxRetries: z.literal(BUDGET.maxRetries),
    maxAltTablesPerMessage: z.literal(BUDGET.maxAltTablesPerMessage),
  }).strict(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  operatorNote: z.string().min(1).max(120).regex(/^[A-Za-z0-9 _.,:-]+$/)
    .refine(s => !/(?:key|secret|private|seed|mnemonic|signature)/i.test(s) && !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(s)),
}).strict();
export type DiagnosticPreflightRequest = z.infer<typeof DiagnosticPreflightRequestSchema>;
const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const safeReason = (e: unknown) => e instanceof Error && ["INCONCLUSIVE_STATE_CHANGED",
  "PREFLIGHT_DURATION_EXCEEDED", "PREFLIGHT_QUOTE_EXPIRED", "PREFLIGHT_FINALITY_TIMEOUT",
  "PREFLIGHT_FINALITY_POLL_LIMIT", "PREFLIGHT_QUOTE_CONTEXT_INVALID", "PREFLIGHT_FINALITY_CONTEXT_INVALID"].includes(e.message)
  ? e.message : "PREFLIGHT_FAILURE_REVIEW_LOCAL_EVIDENCE";

function writeOnce(path: string, data: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { const bytes = Buffer.from(data); let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function json(value: unknown): string { return JSON.stringify(value, null, 2) + "\n"; }
/** Identity validation does not grant financial eligibility. */
export function verifyDiagnosticCandidate(_root: string, manifestPath: string, candidateDigest: string): void {
  const { manifest: m } = verifyCandidateIdentity(manifestPath, candidateDigest);
  if (m.formalRelease !== false || m.fundedReleaseAllowed !== false ||
      !Array.isArray(m.fundedTransports) || m.fundedTransports.length !== 0)
    throw Error("PREFLIGHT_CANDIDATE_FLAGS");
}

export class PreflightEvidence implements NetworkRequestAudit {
  readonly maxAltTablesPerMessage = BUDGET.maxAltTablesPerMessage;
  private readonly startedAtMs: number;
  private quoteDeadlineMs: number | undefined;
  private finalityDeadlineMs: number | undefined;
  private counts = { JUPITER: 0, RPC_READ: 0, SIMULATION: 0 };
  private records: { id: number; kind: string; method: string; startedAtMs: number;
    completedAtMs?: number; status?: number; bodySha256?: string; failure?: string;
    failurePhase?: RequestPhase; purpose: "FINALITY_SYNC" | "UNSIGNED_PREFLIGHT";
    phases: Record<string, unknown>[] }[] = [];
  constructor(readonly path: string, readonly request: DiagnosticPreflightRequest,
    private readonly now: () => number = Date.now, private readonly apiKey?: string,
    startedAtMs = now()) {
    this.startedAtMs = startedAtMs;
    mkdirSync(path); mkdirSync(join(path, "requests")); mkdirSync(join(path, "raw"));
    writeOnce(join(path, "PREFLIGHT-REQUEST.json"), json(request));
  }
  write(name: string, value: unknown): void { writeOnce(join(this.path, name), json(value)); }
  private deadlineMs(): number {
    return Math.min(this.startedAtMs + this.request.requestBudget.maxTotalDurationSeconds * 1000,
      this.request.expiresAt ? Date.parse(this.request.expiresAt) : Infinity,
      this.quoteDeadlineMs ?? Infinity, this.finalityDeadlineMs ?? Infinity);
  }
  assertCurrent(): void {
    const t = this.now();
    if (t >= this.startedAtMs + this.request.requestBudget.maxTotalDurationSeconds * 1000 ||
        (this.request.expiresAt && t >= Date.parse(this.request.expiresAt))) throw Error("PREFLIGHT_DURATION_EXCEEDED");
    if (this.quoteDeadlineMs !== undefined && t >= this.quoteDeadlineMs) throw Error("PREFLIGHT_QUOTE_EXPIRED");
    if (this.finalityDeadlineMs !== undefined && t >= this.finalityDeadlineMs) throw Error("PREFLIGHT_FINALITY_TIMEOUT");
  }
  requestSignal(): AbortSignal {
    this.assertCurrent();
    return AbortSignal.timeout(Math.max(1, Math.ceil(this.deadlineMs() - this.now())));
  }
  quoteStarted(_side: "BUY" | "SELL", deadline: number): void {
    this.assertCurrent(); this.quoteDeadlineMs = deadline;
  }
  finalityStarted(deadline: number): void { this.finalityDeadlineMs = deadline; }
  finalityFinished(side: "BUY" | "SELL", receipt?: FinalityReceipt): void {
    if (receipt) this.write(`${side}-FINALITY-SYNC.json`, receipt);
    this.finalityDeadlineMs = undefined;
  }
  reserve(kind: "RPC_READ" | "SIMULATION" | "JUPITER", method: string, params: unknown): number {
    const t = this.now(), b = this.request.requestBudget;
    this.assertCurrent();
    const limit = kind === "RPC_READ" ? b.maxRpcReadRequests :
      kind === "JUPITER" ? b.maxJupiterRequests : b.maxSimulationRequests;
    if (this.counts[kind] >= limit || this.records.length >= b.maxTotalRequests)
      throw Error("PREFLIGHT_REQUEST_BUDGET_EXCEEDED");
    const encoded = json(params);
    if (this.apiKey && encoded.includes(this.apiKey)) throw Error("PREFLIGHT_SECRET_IN_REQUEST");
    const id = this.records.length + 1;
    const purpose = this.finalityDeadlineMs === undefined ? "UNSIGNED_PREFLIGHT" : "FINALITY_SYNC";
    writeOnce(join(this.path, "requests", `${String(id).padStart(3,"0")}-start.json`),
      json({ id, kind, method, startedAtMs: t, params, purpose }));
    this.counts[kind]++; this.records.push({ id, kind, method, startedAtMs: t, purpose, phases: [] });
    return id;
  }
  complete(id: number, status: number, body: string): void {
    const r = this.records[id - 1];
    if (!r || r.completedAtMs !== undefined) throw Error("PREFLIGHT_REQUEST_RECORD_STATE");
    if (this.apiKey && body.includes(this.apiKey)) throw Error("PREFLIGHT_SECRET_IN_RESPONSE");
    const bodySha256 = sha(body);
    writeOnce(join(this.path, "raw", `${String(id).padStart(3,"0")}-response.json`), body);
    r.completedAtMs = this.now(); r.status = status; r.bodySha256 = bodySha256;
    writeOnce(join(this.path, "requests", `${String(id).padStart(3,"0")}-end.json`), json(r));
  }
  observe(id: number, phase: RequestPhase, fields: Record<string, unknown> = {}): void {
    const r = this.records[id - 1];
    if (!r || r.completedAtMs !== undefined || r.phases.length >= 64) return;
    const event = ["doh.start", "doh.answer", "doh.retry", "doh.error", "doh.cancelled",
      "isolated.resolve", "isolated.cancelled", "lookup.start", "lookup.error", "lookup.end"].includes(String(fields.event))
      ? fields.event : undefined;
    const status = typeof fields.status === "number" && Number.isInteger(fields.status) &&
      fields.status >= 100 && fields.status <= 599 ? fields.status : undefined;
    if (status !== undefined) r.status = status;
    // Projection, never the original resolver record, address, URL, headers or error text.
    const record = { id, phase, atMs: this.now(), ...(event ? { event } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(fields.code ? { code: requestFailureCode(Object.assign(Error("resolver"), { code: fields.code })) } : {}),
      ...(typeof fields.cache === "boolean" ? { cache: fields.cache } : {}) };
    writeOnce(join(this.path, "requests", `${String(id).padStart(3,"0")}-phase-${r.phases.length + 1}.json`), json(record));
    r.phases.push(record);
  }
  fail(id: number, reason: string, phase?: RequestPhase): void {
    const r = this.records[id - 1];
    if (!r || r.completedAtMs !== undefined) return;
    r.completedAtMs = this.now();
    r.failure = requestFailureCode(Object.assign(Error(reason), { code: reason }));
    if (phase) r.failurePhase = phase;
    writeOnce(join(this.path, "requests", `${String(id).padStart(3,"0")}-end.json`), json(r));
  }
  lastFailure() {
    const r = this.records.findLast(record => record.failure !== undefined);
    return r ? { requestId: r.id, kind: r.kind, method: r.method, phase: r.failurePhase,
      code: r.failure, httpStatus: r.status } : null;
  }
  finalLedger(): void { this.write("REQUEST-LEDGER.json", {
    counts: this.counts, total: this.records.length, records: this.records,
    budget: this.request.requestBudget,
  }); }
}

type DiagnosticNetwork = Pick<JupiterSelfRpcNetwork,
  "verifyCluster" | "snapshot" | "order" | "simulate" | "blockhashValid">;
type NetworkFactory = (audit: PreflightEvidence, apiKey: string | undefined) => DiagnosticNetwork;
// Diagnostic and funded paths use the same order/finality implementation.
const defaultNetwork: NetworkFactory = (audit, apiKey) =>
  new JupiterSelfRpcNetwork(process.env.MINIMUM_LIVE_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    false, apiKey, () => {}, audit);

async function reviewOrder(order: LiveOrder, side: "BUY" | "SELL", wallet: string,
  amount: string, evidence: PreflightEvidence) {
  if (order.router !== "metis" || order.inAmount !== amount || !order.poolAddress ||
      order.inputMint !== (side === "BUY" ? WSOL_MINT : USDC_MINT) ||
      order.outputMint !== (side === "BUY" ? USDC_MINT : WSOL_MINT) ||
      order.feeBps !== 0 || !order.cpiEvidence)
    throw Error("PREFLIGHT_ORDER_SCOPE");
  const impact = normalizeJupiterPriceImpact(order);
  if (impact.status !== "AVAILABLE" ||
      !new Decimal(impact.normalizedPct!).abs().lte(LIMITS.maxPriceImpactPct))
    throw Error("PREFLIGHT_PRICE_IMPACT");
  evidence.write(`${side}-UNSIGNED.json`, { transactionBase64: order.transaction,
    transactionSha256: digest(Buffer.from(order.transaction,"base64")),
    requestId: order.requestId, inAmount: order.inAmount, outAmount: order.outAmount,
    poolAddress: order.poolAddress, impact });
  evidence.write(`${side}-CPI-EVIDENCE.json`, order.cpiEvidence);
  const cpi = order.cpiEvidence;
  const review = await reviewTransaction(order.transaction, {
    wallet, side, inputRaw: amount, quotedOutputRaw: order.outAmount,
    maxSlippageBps: LIMITS.maxSlippageBps,
    maxPlatformFeeBps: LIMITS.maxPlatformFeeBps,
    networkFeeCapLamports: LIMITS.networkFeeCapLamports,
    poolAddress: order.poolAddress, requestId: order.requestId,
  }, async key => {
    const fact = cpi.alt[key];
    if (!fact) throw Error("PREFLIGHT_ALT_EVIDENCE_MISSING");
    return decodeIndependentAlt(fact.account);
  }, cpi);
  if (review.abiEvidence !== "OFFICIAL_V1_SINGLE_RAYDIUM_CLMM")
    throw Error("PREFLIGHT_REVIEW_SCOPE");
  evidence.assertCurrent();
  evidence.write(`${side}-REVIEW.json`, review);
  return review;
}

export async function runUnsignedPreflight(root: string, manifestPath: string,
  requestPath: string, networkFactory: NetworkFactory = defaultNetwork,
  now: () => number = Date.now): Promise<Record<string, unknown>> {
  const rawRequest = readFileSync(requestPath, "utf8");
  const request = DiagnosticPreflightRequestSchema.parse(JSON.parse(rawRequest));
  const requestDigest = digest(JSON.stringify(request));
  const current = now();
  if (Date.parse(request.createdAt) > current ||
      (request.expiresAt && current >= Date.parse(request.expiresAt)))
    throw Error("PREFLIGHT_REQUEST_NOT_CURRENT");
  verifyDiagnosticCandidate(root, manifestPath, request.candidateDigest);
  if (existsSync(resolve(root, "var/minimum-live-wallet-claims",
    `${request.walletPublicKey}.json`)))
    throw Error("PREFLIGHT_WALLET_LIABILITY_PRESENT");
  const parent = resolve(root, "var/minimum-live-preflight");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const key = process.env.MINIMUM_LIVE_JUPITER_API_KEY;
  if (key && rawRequest.includes(key)) throw Error("PREFLIGHT_SECRET_IN_REQUEST");
  const output = resolve(parent, requestDigest);
  if (existsSync(output)) throw Error("PREFLIGHT_REQUEST_ALREADY_USED");
  const evidence = new PreflightEvidence(output, request, now, key, current);
  const wallet = request.walletPublicKey;
  try {
    const network = networkFactory(evidence, key);
    await network.verifyCluster();
    const accounts = { wallet, usdcAccount: await associatedAccount(wallet, USDC_MINT),
      wsolAccount: await associatedAccount(wallet, WSOL_MINT) };
    const before: WalletSnapshot = await network.snapshot(accounts);
    evidence.write("WALLET-SNAPSHOT.json", before);
    if (!before.wsolAbsent || before.usdcRaw !== "0")
      throw Error("PREFLIGHT_EXISTING_POSITION_OR_WSOL");
    const buy = await network.order("BUY", wallet, request.diagnosticBuyLamports,
      LIMITS.maxSlippageBps);
    const buyReview = await reviewOrder(buy, "BUY", wallet,
      request.diagnosticBuyLamports, evidence);
    const minimum = BigInt(request.diagnosticBuyLamports) +
      BigInt(LIMITS.networkFeeCapLamports) + BigInt(LIMITS.accountRentCapLamports) +
      BigInt(LIMITS.exitReserveLamports);
    let buySimulation: unknown = "NOT_TESTABLE_INSUFFICIENT_BALANCE";
    if (BigInt(before.walletLamports) >= minimum) {
      if (!(await network.blockhashValid(buyReview.blockhash)))
        throw Error("PREFLIGHT_BLOCKHASH_EXPIRED");
      if (digest(Buffer.from(buy.transaction, "base64")) !== buyReview.transactionDigest)
        throw Error("PREFLIGHT_MESSAGE_CHANGED_AFTER_REVIEW");
      const sim: Simulation = await network.simulate(buy.transaction, buyReview);
      evidence.assertCurrent();
      if (BigInt(sim.slot) < BigInt(before.slot))
        throw Error("INCONCLUSIVE_STATE_CHANGED");
      const rent = BigInt(sim.rentAfterLamports) - BigInt(before.usdcRentLamports);
      const tokenDelta = BigInt(sim.tokenAfterRaw) - BigInt(before.usdcRaw);
      const nativeDelta = BigInt(sim.walletAfterLamports) - BigInt(before.walletLamports) +
        BigInt(sim.feeLamports) + rent;
      if (!sim.wsolClosed || BigInt(sim.feeLamports) > BigInt(LIMITS.networkFeeCapLamports) ||
          rent < 0n || rent > BigInt(LIMITS.accountRentCapLamports) ||
          tokenDelta < BigInt(buyReview.minimumOutputRaw) || nativeDelta >= 0n ||
          -nativeDelta > BigInt(buyReview.inputRaw) ||
          BigInt(sim.walletAfterLamports) < BigInt(LIMITS.exitReserveLamports))
        throw Error("PREFLIGHT_SIMULATION_SCOPE");
      buySimulation = { status: "PASS_UNSIGNED_RPC_ONLY", messageDigest: buyReview.messageDigest,
        transactionDigest: buyReview.transactionDigest, blockhash: buyReview.blockhash,
        parameters: { sigVerify: false, replaceRecentBlockhash: false,
          commitment: "confirmed" }, result: sim };
    }
    evidence.write("BUY-SIMULATION.json", buySimulation);
    const sell = await network.order("SELL", wallet, buy.outAmount,
      LIMITS.maxSlippageBps);
    const sellReview = await reviewOrder(sell, "SELL", wallet, buy.outAmount, evidence);
    evidence.assertCurrent();
    evidence.write("SELL-SIMULATION.json", { status: "NOT_RUN_NO_POSITION",
      amountSource: "DIAGNOSTIC_QUOTE_DERIVED", amountRaw: buy.outAmount,
      currentPositionPresent: false, messageDigest: sellReview.messageDigest });
    const receipt = { version: "UNSIGNED_DIAGNOSTIC_PREFLIGHT_RECEIPT_V1",
      result: "COMPLETE_DIAGNOSTIC_ONLY", candidateDigest: request.candidateDigest,
      requestDigest, walletPublicKey: wallet,
      buySimulation: typeof buySimulation === "string" ? buySimulation : "PASS_UNSIGNED_RPC_ONLY",
      sellRouteReview: "PASS", sellAmountSource: "DIAGNOSTIC_QUOTE_DERIVED",
      sellCurrentPositionPresent: false, sellSimulation: "NOT_RUN_NO_POSITION",
      signCalls: 0, sendCalls: 0, fundedReleaseAllowed: false };
    evidence.finalLedger(); evidence.write("FINAL-RECEIPT.json", receipt);
    return receipt;
  } catch (error) {
    const reason = safeReason(error);
    evidence.finalLedger();
    evidence.write("FINAL-RECEIPT.json", { version: "UNSIGNED_DIAGNOSTIC_PREFLIGHT_RECEIPT_V1",
      result: reason === "INCONCLUSIVE_STATE_CHANGED" ? reason : "STOPPED",
      reason, candidateDigest: request.candidateDigest,
      requestFailure: evidence.lastFailure(),
      requestDigest, signCalls: 0, sendCalls: 0,
      fundedReleaseAllowed: false });
    throw error;
  }
}

export const UNSIGNED_PREFLIGHT_BUDGET = BUDGET;
export const UNSIGNED_PREFLIGHT_SCOPE = SCOPE;
