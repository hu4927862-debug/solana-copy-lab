import {DirectDammV2Builder} from "./damm-direct-builder.js";
import {JupiterV1FullSwapBuilder} from "./jupiter-v1-build-provider.js";
import type {ExecutionBuildProvider} from "./execution-build-provider.js";
import type {ClmmProgramAttestationReference} from "../live/program-attestation.js";
import { constants, closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { JupiterSelfRpcNetwork } from "../live/self-rpc-network.js";
import type { NetworkRequestAudit, RequestPhase } from "../live/adapters.js";
import type { FinalityReceipt } from "../live/quote-finality.js";
import { AutonomousProtocolSchema, digest, executionAsset, protocolDigest, type AutonomousExecutionProtocol } from "../live/protocol.js";
import { LiveExecutor } from "../live/executor.js";
import type { LiveJournal } from "../live/journal.js";
import { collectExpiredRecovery } from "../live/expired-recovery-runner.js";
import { assessExpiredRecovery, recoverySubject, RECOVERY_POLICY, type RecoveryKind } from "../live/expired-recovery.js";
import { associatedAccount, reviewTokenAccount } from "../live/transaction-review.js";
import { WSOL_MINT } from "../domain/assets.js";

export type ExecutionOperation = "EXECUTION" | "RECONCILE" | "RECOVERY";
export interface ExternalExecutionRequest {
  readonly auditPath: string;
  readonly requestId: number;
  readonly atMs: number;
  readonly operation: ExecutionOperation;
  readonly protocolDigest: string;
  readonly kind: "RPC_READ" | "SIMULATION" | "JUPITER" | "SEND";
  readonly method: string;
}
/** Must synchronously reserve the common provider budget, or throw. No transport
 * or asynchronous work belongs here; the original adapter performs the request. */
export type BeforeExecutionRequest = (request: Readonly<ExternalExecutionRequest>) => void;
export interface ExternalExecutionResponse extends ExternalExecutionRequest {
  readonly completedAtMs: number;
  readonly outcome: "COMPLETE" | "FAILED";
  readonly httpStatus?: number;
  readonly responseSha256?: string;
  readonly responseBytes?: number;
  readonly safeCode?: string;
}
export type AfterExecutionRequest = (receipt: Readonly<ExternalExecutionResponse>) => void;
export interface ExecutionTransportGate {
  readonly kind: ExternalExecutionRequest["kind"];
  readonly method: string;
  /** Original operation/quote/finality deadline, never a new pacing window. */
  readonly signal: AbortSignal;
}
export type BeforeExecutionTransport = (request: Readonly<ExecutionTransportGate>) => Promise<void>;
export const EXECUTION_REQUEST_POLICY = Object.freeze({ maxReads: 50, maxJupiter: 2, maxSends: 1, maxDurationMs: 300000 });
const RPC_READS = new Set(["getGenesisHash", "getAccountInfo", "getMultipleAccounts", "getTokenAccountsByOwner", "getFeeForMessage",
  "isBlockhashValid", "getTransaction", "getSignatureStatuses", "getLatestBlockhash", "getSignaturesForAddress", "getFirstAvailableBlock", "getBlockHeight"]);
const SAFE_CODES = new Set(["RPC_ERROR", "INVALID_JSON", "PREFLIGHT_SECRET_IN_RESPONSE", "PREFLIGHT_DURATION_EXCEEDED", "PREFLIGHT_QUOTE_EXPIRED",
  "PREFLIGHT_FINALITY_TIMEOUT", "PREPARATION_DEADLINE_EXCEEDED", "NETWORK_OR_RESPONSE_FAILURE", "OTHER_NETWORK_OR_CONTRACT_ERROR",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED", "ABORT_ERR", "ECONNRESET",
  "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ABORTED", "TIMEOUT"]);
const safeCode = (value: unknown): string => typeof value === "string" && (SAFE_CODES.has(value) || /^(RPC_HTTP_|JUPITER_HTTP_)[1-5][0-9]{2}$/.test(value))
  ? value : "NETWORK_OR_RESPONSE_FAILURE";
const need = (condition: unknown, code: string): void => { if (!condition) throw Error(code); };

function durableFile(file: string, value: unknown): void {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(dirname(file), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** Request reservations are persisted before the original adapter issues fetch.
 * Deliberately omits URLs, headers, parameters, body text and transaction bytes.
 * This is accounting around the existing transport, not retry/fallback transport. */
export class ExecutionRequestAudit implements NetworkRequestAudit {
  readonly maxAltTablesPerMessage = 1;
  readonly path: string;
  readonly deadline: number;
  private readonly starts = new Map<number, number>();
  private readonly reservations = new Map<number, ExternalExecutionRequest>();
  private readonly bodySizes = new Map<number, number>();
  private reads = 0;
  private jupiter = 0;
  private sends = 0;
  private freshQuoteRetryAllowance = 0;
  private count = 0;
  private readonly captured = new Set<number>();
  private readonly dnsTimeoutRequests = new Set<number>();
  constructor(readonly directory: string, readonly operation: ExecutionOperation,
    readonly identity: { protocolDigest: string; candidateDigest: string; wallet: string; tokenMint: string },
    private readonly now: () => number = Date.now,
    private readonly beforeRequest?: BeforeExecutionRequest,
    private readonly afterRequest?: AfterExecutionRequest,
    readonly submissionDeadlineMs?: number,readonly maxSends:1|3 = 1) {
    need(["EXECUTION", "RECONCILE", "RECOVERY"].includes(operation), "EXECUTION_OPERATION_INVALID");
    const operationDeadline = now() + (operation === "RECOVERY" ? RECOVERY_POLICY.maxDurationMs : EXECUTION_REQUEST_POLICY.maxDurationMs);
    if (submissionDeadlineMs !== undefined) need(operation === "EXECUTION" && Number.isSafeInteger(submissionDeadlineMs) && submissionDeadlineMs >= 0 &&
      submissionDeadlineMs <= operationDeadline, "EXECUTION_SUBMISSION_DEADLINE_BOUND");
    this.deadline = Math.min(operationDeadline, submissionDeadlineMs ?? Infinity);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, `requests-${randomUUID()}.jsonl`);
    const fd = openSync(this.path, "wx", 0o600); closeSync(fd);
    this.write({ event: "OPERATION_STARTED", operation, identity, deadline: this.deadline,
      ...(submissionDeadlineMs !== undefined ? { submissionDeadlineMs } : {}), networkRetries: 0,maxSignedByteDeliveries:maxSends });
    const dir = openSync(directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  private write(value: Record<string, unknown>): void {
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try { writeFileSync(fd, JSON.stringify({ ...value, atMs: this.now() }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }
  assertCurrent(): void { need(this.now() < this.deadline, "EXECUTION_OPERATION_DEADLINE"); }
  requestSignal(): AbortSignal { this.assertCurrent(); return AbortSignal.timeout(Math.max(1, Math.ceil(this.deadline - this.now()))); }
  reserve(kind: "RPC_READ" | "SIMULATION" | "JUPITER", method: string, _params: unknown): number {
    this.assertCurrent();
    const send = method === "sendTransaction";
    need((kind === "RPC_READ" && (RPC_READS.has(method) || send)) ||
      (kind === "SIMULATION" && method === "simulateTransaction") ||
      (kind === "JUPITER" && ["v1/GET/quote", "v1/POST/swap-instructions", "v1/POST/swap"].includes(method)), "EXECUTION_REQUEST_METHOD_BOUNDARY");
    if (this.operation !== "EXECUTION") need(kind === "RPC_READ" && !send, "EXECUTION_READ_ONLY_BOUNDARY");
    if (this.operation === "RECOVERY") need(this.count < RECOVERY_POLICY.maxRequests, "RECOVERY_REQUEST_BOUND");
    if (send) need(this.sends < this.maxSends, "EXECUTION_SINGLE_SEND_ONLY");
    else if (kind === "JUPITER") need(this.jupiter < EXECUTION_REQUEST_POLICY.maxJupiter + this.freshQuoteRetryAllowance, "EXECUTION_JUPITER_REQUEST_BOUND");
    else need(this.reads < EXECUTION_REQUEST_POLICY.maxReads, "EXECUTION_READ_REQUEST_BOUND");
    const id = this.count + 1;
    this.write({ event: "REQUEST_RESERVED", id, kind: send ? "SEND" : kind, method });
    this.count = id; this.starts.set(id, this.now());
    if (send) this.sends++; else if (kind === "JUPITER") this.jupiter++; else this.reads++;
    const reservation: ExternalExecutionRequest = Object.freeze({ auditPath: this.path, requestId: id,
      atMs: this.starts.get(id)!, operation: this.operation, protocolDigest: this.identity.protocolDigest,
      kind: send ? "SEND" : kind, method });
    this.reservations.set(id, reservation);
    if (this.beforeRequest) {
      try {
        const returned: unknown = this.beforeRequest(reservation);
        need(!(returned && typeof (returned as { then?: unknown }).then === "function"), "EXECUTION_REQUEST_GATE_MUST_BE_SYNCHRONOUS");
        this.assertCurrent();
        this.write({ event: "EXTERNAL_REQUEST_GATE_RESERVED", id });
      } catch (error) {
        this.write({ event: "EXTERNAL_REQUEST_GATE_REJECTED", id, safeCode: "EXECUTION_EXTERNAL_REQUEST_GATE_FAILED", externalRequestStarted: false });
        throw error;
      }
    }
    return id;
  }
  observe(id: number, phase: RequestPhase, fields?: Record<string, unknown>): void {
    need(this.starts.has(id), "EXECUTION_AUDIT_REQUEST_UNKNOWN");
    if (phase === "DNS" && fields?.code === "ETIMEDOUT") this.dnsTimeoutRequests.add(id);
    this.write({ event: "REQUEST_PHASE", id, phase,
      ...(Number.isInteger(fields?.status) && Number(fields?.status) >= 100 && Number(fields?.status) <= 599 ? { httpStatus: fields!.status } : {}),
      ...(fields?.code !== undefined ? { safeCode: safeCode(fields.code) } : {}) });
  }
  hasDnsTimeout(id: number): boolean { return this.dnsTimeoutRequests.has(id); }
  complete(id: number, status: number, body: string): void {
    need(this.starts.has(id), "EXECUTION_AUDIT_REQUEST_UNKNOWN");
    this.bodySizes.set(id, Buffer.byteLength(body));
    this.write({ event: "REQUEST_COMPLETE", id, httpStatus: status, elapsedMs: this.now() - this.starts.get(id)!,
      responseBytes: Buffer.byteLength(body), responseSha256: digest(body) });
  }
  fail(id: number, reason: string, phase?: RequestPhase): void {
    need(this.starts.has(id), "EXECUTION_AUDIT_REQUEST_UNKNOWN");
    this.write({ event: "REQUEST_FAILED", id, phase, safeCode: safeCode(reason), elapsedMs: this.now() - this.starts.get(id)! });
  }
  transportEvidence(record: Record<string, unknown> | undefined): void {
    const id = Number(record?.requestId);
    if (!record || !this.starts.has(id) || this.captured.has(id)) return;
    this.captured.add(id);
    const receipt: ExternalExecutionResponse = Object.freeze({ ...this.reservations.get(id)!,
      completedAtMs: Number.isSafeInteger(record.completedAtMs) ? Number(record.completedAtMs) : this.now(),
      outcome: record.result === "COMPLETE" ? "COMPLETE" : "FAILED",
      ...(Number.isInteger(record.httpStatus) ? { httpStatus: Number(record.httpStatus) } : {}),
      ...(typeof record.responseSha256 === "string" && /^[a-f0-9]{64}$/.test(record.responseSha256) ? { responseSha256: record.responseSha256 } : {}),
      ...(this.bodySizes.has(id) ? { responseBytes: this.bodySizes.get(id)! } : {}),
      ...(record.safeCode ? { safeCode: safeCode(record.safeCode) } : {}) });
    this.write({ event: "TRANSPORT_FINISHED", id, ...receipt });
    if (this.afterRequest) {
      const returned: unknown = this.afterRequest(receipt);
      need(!(returned && typeof (returned as { then?: unknown }).then === "function"), "EXECUTION_RESPONSE_GATE_MUST_BE_SYNCHRONOUS");
    }
  }
  quoteStarted(side: "BUY" | "SELL", deadline: number): void { this.write({ event: "QUOTE_STARTED", side, quoteExpiresAtMs: deadline }); }
  /** One additional quote request, granted only by the pre-signature owner
   * after a proven no-response DNS/connect timeout. Shared quota is unchanged. */
  allowFreshQuoteRetry(failedRequestId: number): void {
    need(this.operation === "EXECUTION" && this.freshQuoteRetryAllowance === 0 && this.jupiter === 1 && this.sends === 0,
      "EXECUTION_QUOTE_RETRY_BOUND");
    this.assertCurrent();
    this.write({ event: "PRESIGNATURE_FRESH_QUOTE_RETRY_GRANTED", failedRequestId, maxAdditionalRequests: 1,
      originalOperationDeadlineMs: this.deadline });
    this.freshQuoteRetryAllowance = 1;
  }
  finalityStarted(deadline: number): void { this.write({ event: "FINALITY_STARTED", finalityDeadlineMs: deadline }); }
  finalityFinished(side: "BUY" | "SELL", receipt?: FinalityReceipt): void {
    this.write({ event: "FINALITY_FINISHED", side, ...(receipt ? { result: receipt.result, quoteContextSlot: receipt.quoteContextSlot,
      finalizedSlot: receipt.finalizedSlot, ...(receipt.commitment?{commitment:receipt.commitment,confirmedSlot:receipt.confirmedSlot}:{}), polls: receipt.polls, startedAtMs: receipt.startedAtMs, completedAtMs: receipt.completedAtMs } : {}) });
  }
  summary() { return { operation: this.operation, requests: this.count, rpcReads: this.reads, jupiterRequests: this.jupiter,
    sendRequests: this.sends, preSignatureFreshQuoteRetryAllowance: this.freshQuoteRetryAllowance,
    deadline: this.deadline, auditPath: this.path }; }
}

export interface ExecutionNetworkOptions {
  protocol: AutonomousExecutionProtocol;
  journal: LiveJournal;
  rpcUrl: string;
  apiKey?: string;
  evidenceDirectory: string;
  operation?: ExecutionOperation;
  /** Must come from the current independent release + user authorization checks. */
  fundsAuthorized?: boolean;
  /** Final synchronous capital/kill/current authorization check. Runs only for
   * sendTransaction, after Executor's durable UNKNOWN marker and before fetch. */
  assertBeforeSend?: () => void;
  beforeRequest?: BeforeExecutionRequest;
  /** Safe completion for that same shared reservation / response-based pacing. */
  afterRequest?: AfterExecutionRequest;
  /** Shared existing Provider pacing only; may not perform a network request. */
  beforeTransport?: BeforeExecutionTransport;
  /** For a fresh submit adapter: minimum of the signed attempt's ORIGINAL quote,
   * reviewedAt + maxReviewAge and side authority deadline. Never now + freshness. */
  submissionDeadlineMs?: number;
  now?: () => number;
  /** Exact operator-config selection; absence preserves the historical
   * instructions path. Never fall back on endpoint or review failure. */
  buildProvider?: ExecutionBuildSelection;
}

export interface ExecutionBuildSelection {
  readonly id: "JUPITER_V1_FULL_SWAP_SELF_RPC_V1" | "JUPITER_V1_INSTRUCTIONS_SELF_RPC_V1" | "DIRECT_DAMM_V2_EXACT_IN_V1";
  readonly pools?: Readonly<Record<string,string>>;
  readonly clmmProgramAttestationReference?: ClmmProgramAttestationReference;
}
export function selectedExecutionBuilder(protocol: AutonomousExecutionProtocol, selection?: ExecutionBuildSelection): ExecutionBuildProvider | undefined {
  if(protocol.executionScope==="CLASSIC_SOL_EXACT_JUPITER_V1_METEORA_DLMM"){
    need(protocol.transport==="JUPITER_V1_SELF_RPC"&&selection?.id==="JUPITER_V1_FULL_SWAP_SELF_RPC_V1"&&
      selection.pools?.[protocol.tokenMint]===protocol.executionPool&&Object.keys(selection.pools??{}).length===1,"EXECUTION_BUILD_PROVIDER_BINDING");
    return new JupiterV1FullSwapBuilder();
  }
  if (protocol.transport === "DIRECT_DAMM_V2_SELF_RPC") {
    need(!selection || selection.id === "DIRECT_DAMM_V2_EXACT_IN_V1" && selection.pools?.[protocol.tokenMint] === protocol.executionPool,
      "EXECUTION_BUILD_PROVIDER_BINDING");
    return new DirectDammV2Builder(protocol.executionPool!);
  }
  need(protocol.transport === "JUPITER_V1_SELF_RPC" && protocol.executionScope === "CLASSIC_SOL_DYNAMIC_JUPITER_V1_RAYDIUM_CLMM",
    "EXECUTION_BUILD_PROVIDER_BINDING");
  need(!selection || ["JUPITER_V1_FULL_SWAP_SELF_RPC_V1","JUPITER_V1_INSTRUCTIONS_SELF_RPC_V1"].includes(selection.id) && !selection.pools,
    "EXECUTION_BUILD_PROVIDER_BINDING");
  return selection?.id === "JUPITER_V1_FULL_SWAP_SELF_RPC_V1" ? new JupiterV1FullSwapBuilder(protocol.executionPurpose) : undefined;
}

export class AuditedExecutionNetwork extends JupiterSelfRpcNetwork {
  private readonly scopeBinding:{executionScope:string;executionPool?:string;clmmProgramAttestationReference?:ClmmProgramAttestationReference};
  readonly auditPath: string;
  private readonly assertBeforeSend: () => void;
  private readonly beforeTransport: BeforeExecutionTransport | undefined;
  private readonly sendPermitted: boolean;
  private readonly journal: LiveJournal;
  private readonly quoteRetryPermitted: boolean;
  private preparationDeadlineMs: number | undefined;
  private quoteDeadlineMs: number | undefined;
  constructor(options: ExecutionNetworkOptions, readonly audit: ExecutionRequestAudit, deferredRequestAccounting = false) {
    const p = AutonomousProtocolSchema.parse(options.protocol);
    need(options.journal.status().protocolDigest === protocolDigest(p), "EXECUTION_NETWORK_JOURNAL_BINDING");
    need(audit.identity.protocolDigest === protocolDigest(p) && audit.identity.candidateDigest === p.candidateDigest &&
      audit.identity.wallet === p.wallet && audit.identity.tokenMint === p.tokenMint, "EXECUTION_AUDIT_IDENTITY_BINDING");
    const permitted = audit.operation === "EXECUTION" && options.fundsAuthorized === true && p.approval === "FUNDS_AUTHORIZED";
    super(options.rpcUrl, permitted, options.apiKey, deferredRequestAccounting ? () => {} : kind => options.journal.claimRequest(kind), audit, executionAsset(p));
    this.executionBuilder = selectedExecutionBuilder(p, options.buildProvider);
    const reference=options.buildProvider?.clmmProgramAttestationReference;
    need(!reference||p.executionScope==="CLASSIC_SOL_DYNAMIC_JUPITER_V1_RAYDIUM_CLMM"&&p.executionPurpose===undefined&&
      p.deliveryPolicy&&options.buildProvider?.id==="JUPITER_V1_FULL_SWAP_SELF_RPC_V1","PROGRAM_ATTESTATION_REFERENCE_SCOPE");
    this.scopeBinding={executionScope:p.executionScope,...(p.executionPool?{executionPool:p.executionPool}:{}),...(reference?{clmmProgramAttestationReference:reference}:{})};
    this.configureDelivery(p.deliveryPolicy);
    this.auditPath = audit.path;
    this.assertBeforeSend = options.assertBeforeSend ?? (() => {});
    this.beforeTransport = options.beforeTransport;
    this.sendPermitted = permitted;
    this.journal = options.journal;
    this.quoteRetryPermitted = p.executionPurpose === "EXECUTION_FUNCTION_TEST";
  }
  override beginPreparation(deadline: number): void {
    this.preparationDeadlineMs = deadline;
    this.quoteDeadlineMs = undefined;
    super.beginPreparation(deadline);
  }
  override finishPreparation(): void {
    super.finishPreparation(); this.preparationDeadlineMs = this.quoteDeadlineMs = undefined;
  }
  protected override buildContext() {
    const context = super.buildContext(), begin = context.beginQuote;
    return { ...context, ...this.scopeBinding, beginQuote: (side: "BUY" | "SELL") => {
      const deadline = begin(side); this.quoteDeadlineMs = deadline; return deadline;
    } };
  }
  /** No retry is possible for SELL with real inventory, exported bytes, signed
   * responsibility or any send/settlement history. The caller owns no keys. */
  private assertUnrequestedBuy(): void {
    const status = this.journal.status(), attempt = status.obligations[0];
    need(this.audit.operation === "EXECUTION" && this.audit.summary().sendRequests === 0 &&
      !status.takeover && status.positionRaw === "0" && status.obligations.length === 1 && status.attempts.length === 1 &&
      attempt?.side === "BUY" && attempt.state === "CREATED", "EXECUTION_QUOTE_RETRY_RESPONSIBILITY");
    for (const item of status.attempts) {
      need(!["SIGNED", "UNKNOWN", "SETTLED", "CHAIN_FAILED"].includes(item.state) &&
        !["signingRequestIssued", "signingRequest", "exportedArtifact", "signedArtifact", "signature", "signedTransaction",
          "submissionStartedAtMs", "submittedAtMs", "lastSubmissionKind", "providerReceipt", "settlement"]
          .some(key => Object.hasOwn(item.data, key)) &&
        (!Object.hasOwn(item.data, "submissionCount") || item.data.submissionCount === 0), "EXECUTION_QUOTE_RETRY_RESPONSIBILITY");
      this.journal.assertNoSignedHistory(item.id);
    }
  }
  private grantQuoteTimeoutRetry(record: Record<string, unknown> | undefined): boolean {
    if (!this.quoteRetryPermitted || !record || record.kind !== "JUPITER" || record.method !== "v1/GET/quote" || record.result !== "FAILED" ||
      record.phase !== "CONNECT_OR_HEADERS" || Object.hasOwn(record, "httpStatus") ||
      !(record.safeCode === "UND_ERR_CONNECT_TIMEOUT" ||
        record.safeCode === "ETIMEDOUT" && this.audit.hasDnsTimeout(Number(record.requestId)))) return false;
    // Runway uses the existing GET timeout and original quote/preparation
    // deadlines; Provider pacing still applies and may refuse before transport.
    if (this.quoteRetryRunway() < 10000) return false;
    try {
      return this.journal.atomic(() => {
        this.assertUnrequestedBuy();
        const attempt = this.journal.status().obligations[0]!;
        if (Object.hasOwn(attempt.data, "preSignatureQuoteRetryCount")) return false;
        this.journal.transition(attempt.id, "CREATED", "CREATED", { preSignatureQuoteRetryCount: 1,
          preSignatureQuoteRetry: { failedRequestId: Number(record.requestId), safeCode: record.safeCode,
            originalQuoteDeadlineMs: this.quoteDeadlineMs, originalPreparationDeadlineMs: this.preparationDeadlineMs } });
        this.audit.allowFreshQuoteRetry(Number(record.requestId));
        return true;
      });
    } catch (error) {
      if (error instanceof Error && ["EXECUTION_QUOTE_RETRY_RESPONSIBILITY", "RECOVERY_SIGNED_OR_SEND_HISTORY"].includes(error.message)) return false;
      throw error;
    }
  }
  private quoteRetryRunway(): number {
    return Math.min(this.audit.deadline, this.preparationDeadlineMs ?? -Infinity,
      this.quoteDeadlineMs ?? -Infinity) - Date.now();
  }
  private async transportGate(kind: ExternalExecutionRequest["kind"], method: string): Promise<void> {
    this.assertRequestCurrent();
    if (kind === "SEND") need(this.sendPermitted, "FUNDS_NOT_AUTHORIZED");
    if (this.audit.operation !== "EXECUTION") need(kind === "RPC_READ", "EXECUTION_READ_ONLY_BOUNDARY");
    if (this.beforeTransport) {
      const signal = this.requestDeadlineSignal()!;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          try { this.assertRequestCurrent(); reject(Error("EXECUTION_TRANSPORT_GATE_ABORTED")); } catch (error) { reject(error); }
        };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        // Attach both handlers even when the deadline wins; no orphaned rejection
        // and no request may start after the original deadline has elapsed.
        Promise.resolve().then(() => this.beforeTransport!(Object.freeze({ kind, method, signal }))).then(
          () => { signal.removeEventListener("abort", abort); resolve(); },
          error => { signal.removeEventListener("abort", abort); reject(error); },
        );
      });
    }
    this.assertRequestCurrent();
  }
  protected override async rpc(method: string, params: unknown[]): Promise<any> {
    try {
      need(RPC_READS.has(method) || method === "simulateTransaction" || method === "sendTransaction", "LIVE_RPC_METHOD_BOUNDARY");
      await this.transportGate(method === "sendTransaction" ? "SEND" : method === "simulateTransaction" ? "SIMULATION" : "RPC_READ", method);
      // No await between this guard and the original adapter's fetch. READ and
      // recovery remain possible after entry is killed; no caller can reset T0.
      if (method === "sendTransaction") this.assertBeforeSend();
      return await super.rpc(method, params);
    }
    finally { this.audit.transportEvidence(this.requestEvidence().at(-1)); }
  }
  protected override async jupiter(path: string, method: "GET" | "POST", body?: unknown, version = "v2"): Promise<unknown> {
    const before = this.requestEvidence().length;
    const request = async (retry: boolean): Promise<unknown> => {
      try {
      const safeMethod = `${version}/${method}/${path.split("?")[0]}`;
      need(["v1/GET/quote", "v1/POST/swap-instructions", "v1/POST/swap"].includes(safeMethod), "EXECUTION_REQUEST_METHOD_BOUNDARY");
      await this.transportGate("JUPITER", safeMethod);
      if (retry) {
        this.journal.atomic(() => this.assertUnrequestedBuy());
        need(this.quoteRetryRunway() >= 10000, "EXECUTION_QUOTE_RETRY_DEADLINE_INFEASIBLE");
      }
      return await super.jupiter(path, method, body, version);
      } finally { this.audit.transportEvidence(this.requestEvidence().at(-1)); }
    };
    try { return await request(false); }
    catch (error) {
      const records = this.requestEvidence();
      if (records.length <= before || !this.grantQuoteTimeoutRetry(records.at(-1))) throw error;
      // Same prospective query, one entirely new HTTP response. The original
      // quote clock is NOT restarted and no prior quote/build result is reused.
      return request(true);
    }
  }
  requestAuditSummary() { return this.audit.summary(); }
}

export function createExecutionNetwork(options: ExecutionNetworkOptions): AuditedExecutionNetwork {
  const p = AutonomousProtocolSchema.parse(options.protocol);
  need(options.journal.status().protocolDigest === protocolDigest(p), "EXECUTION_NETWORK_JOURNAL_BINDING");
  selectedExecutionBuilder(p, options.buildProvider); // reject a config mismatch before state/audit creation
  const audit = new ExecutionRequestAudit(options.evidenceDirectory, options.operation ?? "EXECUTION", {
    protocolDigest: protocolDigest(p), candidateDigest: p.candidateDigest, wallet: p.wallet, tokenMint: p.tokenMint }, options.now ?? Date.now, options.beforeRequest, options.afterRequest, options.submissionDeadlineMs,p.deliveryPolicy?.maxBroadcasts??1);
  return new AuditedExecutionNetwork(options, audit);
}

export interface ExpiredAutonomousRecoveryOptions {
  protocol: AutonomousExecutionProtocol;
  journal: LiveJournal;
  attemptId: string;
  kind: RecoveryKind;
  rpcUrl: string;
  evidenceDirectory: string;
  /** Re-check current release/protocol/episode claim binding; called before reads
   * and again synchronously inside the Journal commit transaction. */
  assertCurrentBinding: () => void;
  beforeRequest?: BeforeExecutionRequest;
  afterRequest?: AfterExecutionRequest;
  beforeTransport?: BeforeExecutionTransport;
  now?: () => number;
}

/** Explicit operator recovery only. No research, quote, simulation, signature,
 * send, retry or claim deletion. Existing Executor owns the terminal mutation;
 * runtime.tick owns any subsequent zero-position claim/capital release. */
export async function recoverExpiredAutonomousAttempt(options: ExpiredAutonomousRecoveryOptions) {
  const p = AutonomousProtocolSchema.parse(options.protocol), j = options.journal, now = options.now ?? Date.now;
  options.assertCurrentBinding();
  need(options.kind === "UNSIGNED" || options.kind === "SIGNED_UNSENT" || options.kind === "SUBMITTED", "RECOVERY_KIND");
  // One consistent local baseline; another process cannot slip a Journal change
  // between the captured attempt/position and its comparison digest.
  const { original, status, subject, before } = j.atomic(() => {
    const status = j.status(); need(status.protocolDigest === protocolDigest(p), "RECOVERY_PROTOCOL_BINDING");
    const original = j.get(options.attemptId); need(original, "ATTEMPT_NOT_FOUND");
    if (options.kind === "UNSIGNED") j.assertNoSignedHistory(options.attemptId);
    else if(options.kind === "SIGNED_UNSENT") j.assertSignedUnsentHistory(options.attemptId);
    else j.assertSubmittedHistory(options.attemptId,p.deliveryPolicy?.maxBroadcasts??1,p.deliveryPolicy?.broadcastIntervalMs??0);
    need(status.obligations.length === 1 && status.obligations[0]!.id === options.attemptId, "RECOVERY_OTHER_OBLIGATIONS");
    return { original: original!, status, subject: recoverySubject(p, original!, status.positionRaw, now(), options.kind), before: j.recoveryDigest() };
  });
  need(reviewTokenAccount(subject.review) === await associatedAccount(p.wallet, p.tokenMint) &&
    subject.review.wsolAccount === await associatedAccount(p.wallet, WSOL_MINT), "RECOVERY_ATA_BINDING");
  const output = join(options.evidenceDirectory, `expired-recovery-${now()}-${randomUUID()}`);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const audit = new ExecutionRequestAudit(output, "RECOVERY", { protocolDigest: protocolDigest(p), candidateDigest: p.candidateDigest,
    wallet: p.wallet, tokenMint: p.tokenMint }, now, options.beforeRequest, options.afterRequest);
  durableFile(join(output, "IDENTITY.json"), { schema: "AUTONOMOUS_EXISTING_OBLIGATION_RECOVERY_V1", protocolDigest: protocolDigest(p),
    candidateDigest: p.candidateDigest, experimentId: p.experimentId, wallet: p.wallet, attemptId: options.attemptId, kind: options.kind,
    journalBeforeDigest: before, attemptDigest: digest(JSON.stringify(original)), policy: RECOVERY_POLICY });
  const network = new AuditedExecutionNetwork({ protocol: p, journal: j, rpcUrl: options.rpcUrl, evidenceDirectory: output,
    operation: "RECOVERY", fundsAuthorized: false, now, ...(options.beforeTransport ? { beforeTransport: options.beforeTransport } : {}) }, audit, true);
  let committed = false;
  try {
    const evidence = await collectExpiredRecovery(p, original!, status.positionRaw, network, now, options.kind);
    const receipt = assessExpiredRecovery(p, original!, status.positionRaw, evidence, now(), options.kind);
    durableFile(join(output, "ELIGIBILITY.json"), receipt);
    audit.assertCurrent();
    const closure = j.atomic(() => {
      options.assertCurrentBinding();
      need(j.recoveryDigest() === before && digest(JSON.stringify(j.get(options.attemptId))) === receipt.attemptDigest, "RECOVERY_JOURNAL_CHANGED");
      for (let i = 0; i < audit.summary().requests; i++) j.claimRequest("READ");
      const executor = new LiveExecutor(j, p, network, now);
      return options.kind === "UNSIGNED" ? executor.abandonExpiredUnsigned(options.attemptId, evidence)
        : options.kind === "SIGNED_UNSENT" ? executor.abandonExpiredSignedUnsent(options.attemptId, evidence)
        : executor.expireSubmittedNotLanded(options.attemptId, evidence);
    });
    committed = true;
    durableFile(join(output, "CLOSURE.json"), closure);
    const result = { state: closure.state, evidencePath: output, requestCount: audit.summary().requests,
      journalClosed: j.status().closed, positionRaw: j.status().positionRaw, claimReleased: false };
    durableFile(join(output, "RESULT.json"), result);
    return result;
  } catch (error) {
    const code = error instanceof Error && /^(RECOVERY_|EXECUTION_|ATTEMPT_|PROTOCOL_)[A-Z0-9_]+$/.test(error.message)
      ? error.message : "RECOVERY_FAILED_REVIEW_EVIDENCE";
    durableFile(join(output, "FAILURE.json"), { code, phase: committed ? "COMMITTED_EVIDENCE_WRITE_FAILED" : "NOT_COMMITTED",
      requestCount: audit.summary().requests, atMs: now() });
    throw Error(`${code}: evidencePath=${output}`);
  }
}
