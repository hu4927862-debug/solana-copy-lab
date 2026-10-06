import type { ProgramProof } from "./program-attestation.js";
import { createHash } from "node:crypto";
import type { FinalityReceipt } from "./quote-finality.js";
import { Agent } from "undici";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { createIsolatedResolver, queryDoh, safeNetworkCode, type ResolverAudit } from "../network/v6-isolated-dns.js";
import { USDC_MINT, WSOL_MINT } from "../domain/assets.js";
import { PROGRAM_IDS } from "../decoder/program-registry.js";
import { associatedAccount, decodeWire, reviewAsset, reviewTokenAccount, type TransactionReview } from "./transaction-review.js";
import { ExecutionAssetSchema, MANUAL_EXECUTION_ASSET, type ExecutionAsset } from "./protocol.js";
import type { CpiSemanticEvidence } from "./cpi-semantic-evidence.js";

export interface LiveOrder {
  programIdentityProof?: ProgramProof;
  finalitySync?: FinalityReceipt;
  quoteExpiresAtMs?: number;
  cpiEvidence?: CpiSemanticEvidence;
  poolAddress?: string;
  blockhashContextSlot?: number;
  lastValidBlockHeight?: string;
  transaction: string;
  requestId: string;
  inAmount: string;
  outAmount: string;
  inputMint: string;
  outputMint: string;
  router: string;
  priceImpactPct?: unknown;
  priceImpact?: unknown;
  feeBps: number;
}
export interface WalletSnapshot {
  tokenMint?: string;
  tokenRaw?: string;
  tokenRentLamports?: string;
  slot: string;
  walletLamports: string;
  usdcRaw: string;
  usdcRentLamports: string;
  wsolAbsent: boolean;
}
export function snapshotToken(snapshot: WalletSnapshot, asset: ExecutionAsset): { raw: string; rent: string } {
  if (snapshot.tokenMint !== undefined) {
    if (snapshot.tokenMint !== asset.tokenMint || snapshot.tokenRaw === undefined || snapshot.tokenRentLamports === undefined)
      throw Error("SNAPSHOT_TOKEN_BINDING");
    return { raw: snapshot.tokenRaw, rent: snapshot.tokenRentLamports };
  }
  if (asset.tokenMint !== USDC_MINT || asset.tokenDecimals !== 6) throw Error("SNAPSHOT_TOKEN_BINDING");
  return { raw: snapshot.usdcRaw, rent: snapshot.usdcRentLamports };
}
export interface Simulation {
  slot: string;
  feeLamports: string;
  walletAfterLamports: string;
  tokenAfterRaw: string;
  rentAfterLamports: string;
  wsolClosed: boolean;
  logs: string[];
}
/** Optional diagnostic request gate. A reservation is durable before fetch. */
export interface NetworkRequestAudit {
  readonly maxAltTablesPerMessage: number;
  reserve(kind: "RPC_READ" | "SIMULATION" | "JUPITER", method: string, params: unknown): number;
  complete(id: number, status: number, body: string): void;
  fail(id: number, reason: string, phase?: RequestPhase, details?: {
    httpStatus?: number;
    bodySha256?: string;
    bodyBytes?: number;
    jsonRpcError?: { code: number | null; message: string | null; dataContext: Record<string, number> };
  }): void;
  observe?(id: number, phase: RequestPhase, fields?: Record<string, unknown>): void;
  requestSignal?(): AbortSignal;
  assertCurrent?(): void;
  quoteStarted?(side: "BUY" | "SELL", deadline: number): void;
  finalityStarted?(deadline: number): void;
  finalityFinished?(side: "BUY" | "SELL", receipt?: FinalityReceipt): void;
}
export type RequestPhase = "REQUEST_CLAIM" | "CONNECT_OR_HEADERS" | "DNS" |
  "RESPONSE_BODY" | "HTTP_STATUS" | "RESPONSE_PARSE" | "RPC_RESULT";
function safeJsonRpcError(value: unknown, rpcUrl: string, apiKey?: string) {
  const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const secrets = [rpcUrl, apiKey, new URL(rpcUrl).searchParams.get("api-key")].filter(Boolean) as string[];
  let message = typeof error.message === "string" ? error.message : null;
  if (message !== null) {
    for (const secret of secrets) message = message.replaceAll(secret, "<REDACTED>");
    message = message.replace(/https?:\/\/[^\s"']+/g, "<URL_REDACTED>")
      .replace(/(?:api[-_]?key|authorization|token)\s*[:=]\s*[^\s,;"']+/gi, "<CREDENTIAL_REDACTED>")
      .slice(0, 1024);
  }
  const data = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : {};
  const context = data.context && typeof data.context === "object" ? data.context as Record<string, unknown> : {};
  const dataContext: Record<string, number> = {};
  for (const key of ["contextSlot", "slot", "minContextSlot", "blockHeight", "lastValidBlockHeight", "numSlotsBehind"]) {
    const candidate = data[key] ?? context[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) dataContext[key] = candidate;
  }
  return { code: typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : null,
    message, dataContext };
}
export function requestFailureCode(error: unknown, depth = 0): string {
  if (depth >= 5) return "NETWORK_OR_RESPONSE_FAILURE";
  const known = safeNetworkCode(error);
  if (known !== "OTHER_NETWORK_OR_CONTRACT_ERROR") return known;
  if (error instanceof Error) {
    if (error instanceof SyntaxError) return "INVALID_JSON";
    if (/^(?:RPC_HTTP_|JUPITER_HTTP_)[1-5][0-9]{2}$/.test(error.message)) return error.message;
    if (["RPC_ERROR", "INVALID_JSON", "PREFLIGHT_SECRET_IN_RESPONSE", "PREFLIGHT_DURATION_EXCEEDED",
      "PREFLIGHT_QUOTE_EXPIRED", "PREFLIGHT_FINALITY_TIMEOUT", "PREPARATION_DEADLINE_EXCEEDED"].includes(error.message)) return error.message;
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET", "UND_ERR_ABORTED"].includes(code)) return code;
    if (error.cause) return requestFailureCode(error.cause, depth + 1);
  }
  return "NETWORK_OR_RESPONSE_FAILURE";
}
export interface LiveNetwork {
  verifyProgramIdentity?(requiredSlot: number): Promise<ProgramProof>;
  beginPreparation?(deadline: number): void;
  finishPreparation?(): void;
  assertCurrentEvidence?(): void;
  finalityEvidence?(): FinalityReceipt | undefined;
  requestEvidence?(): readonly Record<string, unknown>[];
  order(
    side: "BUY" | "SELL",
    wallet: string,
    amount: string,
    slippageBps: number,
  ): Promise<LiveOrder>;
  resolveLookup(key: string): Promise<readonly string[]>;
  snapshot(
    review: Pick<TransactionReview, "wallet" | "usdcAccount" | "wsolAccount" | "asset" | "tokenAccount">,
    minSlot?: string,
  ): Promise<WalletSnapshot>;
  simulate(transaction: string, review: TransactionReview): Promise<Simulation>;
  blockhashValid(blockhash: string): Promise<boolean>;
  execute(signedTransaction: string, requestId: string): Promise<unknown>;
  finalizedTransaction(signature: string): Promise<unknown | null>;
  signatureStatus(signature: string): Promise<unknown>;
}

function lossless(text: string): unknown {
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value)
        ? context?.source
        : value,
  );
}
function raw(v: unknown): string {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    return String(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return v;
  throw new Error("INVALID_RPC_INTEGER");
}
type Obj = Record<string, any>;
/** Simulation post-state only, not persisted-chain nonexistence. Agave can
 * serialize the closed account before zero-lamport account cleanup. The caller
 * requests the reviewed WSOL ATA; review requires CloseAccount to this wallet.
 * Do not generalize this to snapshot(), Token accounts, or rentEpoch values. */
function simulatedWsolClosed(account: Obj | null | undefined): boolean {
  return account === null || (account !== undefined &&
    account.lamports === 0 && account.owner === PROGRAM_IDS.SYSTEM &&
    account.executable === false && account.space === 0 &&
    Array.isArray(account.data) && account.data.length === 2 &&
    account.data[0] === "" && account.data[1] === "base64");
}
function tokenAccount(
  account: Obj | null,
  wallet: string,
  mint: string,
): { amount: string; rent: string } {
  if (account === null) return { amount: "0", rent: "0" };
  if (
    account.owner !== PROGRAM_IDS.TOKEN ||
    !Array.isArray(account.data) ||
    account.data[1] !== "base64"
  )
    throw new Error("UNSUPPORTED_TOKEN_ACCOUNT");
  const d = Buffer.from(account.data[0], "base64");
  const key = (bytes: Buffer) => bs58.encode(bytes);
  if (
    d.length !== 165 ||
    key(d.subarray(0, 32)) !== mint ||
    key(d.subarray(32, 64)) !== wallet ||
    d[108] !== 1 ||
    d.readUInt32LE(72) !== 0 ||
    d.readUInt32LE(129) !== 0
  )
    throw new Error("TOKEN_ACCOUNT_AUTHORITY_OR_STATE");
  return {
    amount: d.readBigUInt64LE(64).toString(),
    rent: raw(account.lamports),
  };
}
import bs58 from "bs58";

export class JupiterLiveHttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicDiagnostic: unknown,
  ) {
    super(`JUPITER_HTTP_${status}`);
  }
}
export class UnsignedSimulationError extends Error {
  constructor(readonly diagnostic: unknown) {
    super("UNSIGNED_SIMULATION_FAILED");
  }
}

/** The Paper-only fetch remains untouched. This separate adapter reuses its
 * isolated resolver; it never reads .env or logs URLs/headers/provider bodies. */
export class JupiterManagedNetwork implements LiveNetwork {
  protected readonly asset: ExecutionAsset;
  private readonly resolver;
  private readonly resolverRequest = new AsyncLocalStorage<number>();
  private lastOrderMs = 0;
  private readRequests = 0;
  protected lastRequestId = 0;
  protected requestPurpose(): string { return "LIVE_COMMAND"; }
  protected rpcEndpoint(_method: string): string { return this.rpcUrl; }
  private readonly commandRequests: Record<string, unknown>[] = [];
  requestEvidence(): readonly Record<string, unknown>[] { return structuredClone(this.commandRequests); }
  protected assertRequestCurrent(): void { this.requestAudit?.assertCurrent?.(); }
  protected requestDeadlineSignal(): AbortSignal | undefined { return this.requestAudit?.requestSignal?.(); }

  constructor(
    private readonly rpcUrl: string,
    private readonly fundsAuthorized: boolean,
    private readonly apiKey: string | undefined = undefined,
    private readonly claimRequest: (
      kind: "READ" | "NEW_EXECUTION",
    ) => void = () => {},
    protected readonly requestAudit?: NetworkRequestAudit,
    asset: ExecutionAsset = MANUAL_EXECUTION_ASSET,
  ) {
    this.asset = Object.freeze(ExecutionAssetSchema.parse(asset));
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:") throw new Error("RPC_REQUIRES_HTTPS");
    const audit: ResolverAudit = record => {
      const id = this.resolverRequest.getStore();
      if (id !== undefined) requestAudit?.observe?.(id, "DNS", record);
    };
    this.resolver = requestAudit
      ? createIsolatedResolver({ audit, query: (host, type, signal) =>
          queryDoh(host, type, "cloudflare", audit, signal, 1) })
      : createIsolatedResolver();
  }
  protected async rpc(method: string, params: unknown[]): Promise<any> {
    if (
      ![
        "getGenesisHash",
        "getAccountInfo",
        "getMultipleAccounts",
        "getTokenAccountsByOwner",
        "getFeeForMessage",
        "simulateTransaction",
        "isBlockhashValid",
        "getTransaction",
        "getSignatureStatuses",
        "getLatestBlockhash",
        "getSignaturesForAddress",
        "getFirstAvailableBlock",
        "getBlockHeight",
        "sendTransaction",
      ].includes(method)
    )
      throw new Error("LIVE_RPC_METHOD_BOUNDARY");
    if (method === "sendTransaction" && !this.fundsAuthorized)
      throw new Error("FUNDS_NOT_AUTHORIZED");
    if (method !== "sendTransaction" && ++this.readRequests > 50)
      throw new Error("READ_ONLY_COMMAND_BUDGET_EXHAUSTED");
    this.assertRequestCurrent();
    const auditId = this.requestAudit?.reserve(
      method === "simulateTransaction" ? "SIMULATION" : "RPC_READ",
      method,
      params,
    );
    this.lastRequestId = auditId ?? this.commandRequests.length + 1;
    const record: Record<string, unknown> = { requestId: this.lastRequestId, kind: "RPC",
      method, purpose: this.requestPurpose(), startedAtMs: Date.now(),
      ...(method === "getLatestBlockhash" ? { commitment: (params[0] as Obj)?.commitment } : {}) };
    if (method === "sendTransaction") {
      const options = params[1] as Obj | undefined;
      record.sendConfig = Object.fromEntries(["encoding", "skipPreflight", "preflightCommitment", "maxRetries"]
        .filter(key => options?.[key] !== undefined).map(key => [key, options![key]]));
      // Existing legacy fixture callers may use a placeholder. Production
      // already reviews canonical bytes; audit enrichment adds no old gate.
      try {
        const wire = decodeWire(String(params[0]));
        record.wireBytes = wire.bytes.length;
        record.messageDigest = createHash("sha256").update(Buffer.from(wire.transaction.messageBytes)).digest("hex");
        record.blockhash = wire.message.lifetimeToken;
      } catch { /* retain the ordinary RPC behavior and its failure evidence */ }
    }
    this.commandRequests.push(record);
    let phase: RequestPhase = "REQUEST_CLAIM";
    try {
    this.claimRequest(method === "sendTransaction" ? "NEW_EXECUTION" : "READ");
    phase = "CONNECT_OR_HEADERS";
    if (auditId !== undefined) this.requestAudit?.observe?.(auditId, phase);
    const response = await fetch(this.rpcEndpoint(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.any([AbortSignal.timeout(10000),
        ...([this.requestDeadlineSignal()].filter(Boolean) as AbortSignal[])]),
      redirect: "error",
    });
    phase = "RESPONSE_BODY";
    if (auditId !== undefined) this.requestAudit?.observe?.(auditId, phase, { status: response.status });
    record.httpStatus = response.status;
    const body = await response.text();
    record.responseSha256 = createHash("sha256").update(body).digest("hex");
    record.responseBytes = Buffer.byteLength(body);
    this.assertRequestCurrent();
    phase = "HTTP_STATUS";
    if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
    phase = "RESPONSE_PARSE";
    const result = lossless(body) as Obj;
    phase = "RPC_RESULT";
    if (result.error) record.jsonRpcError = safeJsonRpcError(result.error, this.rpcUrl, this.apiKey);
    if (result.error || !Object.hasOwn(result, "result"))
      throw new Error("RPC_ERROR");
    if (method === "getLatestBlockhash") {
      const slot = result.result?.context?.slot;
      const value = result.result?.value;
      if (typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0) record.contextSlot = slot;
      if (typeof value?.blockhash === "string") record.blockhash = value.blockhash;
      if (value?.lastValidBlockHeight !== undefined) {
        try { record.lastValidBlockHeight = raw(value.lastValidBlockHeight); } catch { /* public metadata only */ }
      }
    }
    record.result = "COMPLETE";
    if (auditId !== undefined) this.requestAudit!.complete(auditId, response.status, body);
    return result.result;
    } catch (error) {
      try { this.assertRequestCurrent(); } catch (deadline) { error = deadline; }
      Object.assign(record, { result: "FAILED", safeCode: requestFailureCode(error), phase });
      if (auditId !== undefined) this.requestAudit!.fail(auditId,
        requestFailureCode(error), phase, {
          ...(typeof record.httpStatus === "number" ? { httpStatus: record.httpStatus } : {}),
          ...(typeof record.responseSha256 === "string" ? { bodySha256: record.responseSha256 } : {}),
          ...(typeof record.responseBytes === "number" ? { bodyBytes: record.responseBytes } : {}),
          ...(record.jsonRpcError ? { jsonRpcError: record.jsonRpcError as { code: number | null; message: string | null; dataContext: Record<string, number> } } : {}),
        });
      throw error;
    } finally { record.completedAtMs = Date.now(); }
  }
  /** Recovery-only public read seam; cannot quote, simulate, sign or send. */
  async recoveryRead(method: string, params: unknown[]): Promise<any> {
    if (!["getGenesisHash","getLatestBlockhash","isBlockhashValid","getFirstAvailableBlock","getBlockHeight",
      "getSignaturesForAddress","getTransaction","getSignatureStatuses"].includes(method)) throw Error("RECOVERY_RPC_METHOD_BOUNDARY");
    return this.rpc(method,params);
  }
  async verifyCluster(): Promise<void> {
    if (
      (await this.rpc("getGenesisHash", [])) !==
      // Full RPC genesis hash; CAIP-2's 32-character reference is not an RPC identity.
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
    )
      throw new Error("NOT_MAINNET_BETA");
  }
  protected async jupiter(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    version = "v2",
  ): Promise<unknown> {
    if (
      method === "POST" &&
      path !== "swap-instructions" &&
      path !== "swap" &&
      !this.fundsAuthorized
    )
      throw new Error("FUNDS_NOT_AUTHORIZED");
    const endpoint = path.split("?")[0];
    if (!["quote", "swap-instructions", "swap", "order", "execute"].includes(endpoint!))
      throw Error("LIVE_JUPITER_METHOD_BOUNDARY");
    const deadlineSignal = this.requestDeadlineSignal();
    const auditId = this.requestAudit?.reserve("JUPITER", `${version}/${method}/${endpoint}`, body ?? null);
    this.lastRequestId = auditId ?? this.commandRequests.length + 1;
    // Endpoint only: never persist authenticated URLs, headers, keys or body text.
    const record: Record<string, unknown> = { requestId: this.lastRequestId, kind: "JUPITER",
      method: `${version}/${method}/${endpoint}`, purpose: this.requestPurpose(), startedAtMs: Date.now() };
    this.commandRequests.push(record);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(method === "GET" ? 10000 : 15000),
      ...(deadlineSignal ? [deadlineSignal] : []),
    ]);
    const lookup = this.resolver.lookupFor(signal);
    const agent = new Agent({
      connect: {
        rejectUnauthorized: true,
        lookup: (host, opts, callback) => {
          if (auditId === undefined) lookup(host, opts, callback);
          else this.resolverRequest.run(auditId, () => {
            this.requestAudit?.observe?.(auditId, "DNS", { event: "lookup.start" });
            lookup(host, opts, (error, address, family) => {
              this.requestAudit?.observe?.(auditId, "DNS", { event: error ? "lookup.error" : "lookup.end",
                ...(error ? { code: requestFailureCode(error) } : {}) });
              callback(error, address, family);
            });
          });
        },
      },
    });
    let phase: RequestPhase = "REQUEST_CLAIM";
    try {
      this.claimRequest("NEW_EXECUTION");
      phase = "CONNECT_OR_HEADERS";
      if (auditId !== undefined) this.requestAudit?.observe?.(auditId, phase);
      const response = await fetch(
        `https://api.jup.ag/swap/${version}/${path}`,
        {
          method,
          headers: {
            accept: "application/json",
            ...(body ? { "content-type": "application/json" } : {}),
            ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal,
          redirect: "error",
          dispatcher: agent,
        } as unknown as RequestInit,
      );
      phase = "RESPONSE_BODY";
      if (auditId !== undefined) this.requestAudit?.observe?.(auditId, phase, { status: response.status });
      record.httpStatus = response.status;
      const rawBody = await response.text();
      record.responseSha256 = createHash("sha256").update(rawBody).digest("hex");
      this.assertRequestCurrent();
      phase = "HTTP_STATUS";
      if (!response.ok) {
        const result = lossless(rawBody) as Obj;
        throw new JupiterLiveHttpError(response.status, {
          code: result.code,
          error: result.error,
          message: result.message,
        });
      }
      phase = "RESPONSE_PARSE";
      const result = lossless(rawBody);
      record.result = "COMPLETE";
      if (auditId !== undefined) this.requestAudit!.complete(auditId, response.status, rawBody);
      return result;
    } catch (error) {
      try { this.assertRequestCurrent(); } catch (deadline) { error = deadline; }
      Object.assign(record, { result: "FAILED", safeCode: requestFailureCode(error), phase });
      if (auditId !== undefined) this.requestAudit!.fail(auditId,
        requestFailureCode(error), phase);
      throw error;
    } finally {
      record.completedAtMs = Date.now();
      controller.abort();
      await agent.destroy();
    }
  }
  async order(
    side: "BUY" | "SELL",
    wallet: string,
    amount: string,
    slippageBps: number,
  ): Promise<LiveOrder> {
    if (this.asset.tokenMint !== USDC_MINT) throw Error("DYNAMIC_MANAGED_ROUTE_UNSUPPORTED");
    if (Date.now() - this.lastOrderMs < 2100)
      throw new Error("LIVE_ORDER_PACING");
    this.lastOrderMs = Date.now();
    const query = new URLSearchParams({
      inputMint: side === "BUY" ? WSOL_MINT : USDC_MINT,
      outputMint: side === "BUY" ? USDC_MINT : WSOL_MINT,
      amount,
      taker: wallet,
      slippageBps: String(slippageBps),
      excludeRouters: "jupiterz,dflow,okx",
    });
    return z
      .object({
        transaction: z.string().min(1),
        requestId: z.string().min(1),
        inAmount: z.string().regex(/^\d+$/),
        outAmount: z.string().regex(/^[1-9]\d*$/),
        inputMint: z.string(),
        outputMint: z.string(),
        router: z.literal("metis"),
        feeBps: z.number().int().nonnegative(),
        priceImpact: z.unknown().optional(),
        priceImpactPct: z.unknown().optional(),
      })
      .parse(await this.jupiter(`order?${query}`, "GET"));
  }
  async resolveLookup(key: string): Promise<readonly string[]> {
    const r = await this.rpc("getAccountInfo", [
      key,
      { encoding: "base64", commitment: "finalized" },
    ]);
    if (r.value?.owner !== "AddressLookupTab1e1111111111111111111111111")
      throw new Error("LOOKUP_OWNER");
    const d = Buffer.from(r.value.data[0], "base64");
    if (
      d.length < 56 ||
      (d.length - 56) % 32 !== 0 ||
      d.readUInt32LE(0) !== 1 ||
      d.readBigUInt64LE(4) !== 18446744073709551615n
    )
      throw new Error("LOOKUP_INVALID_OR_DEACTIVATING");
    return Array.from({ length: (d.length - 56) / 32 }, (_, i) =>
      bs58.encode(d.subarray(56 + i * 32, 88 + i * 32)),
    );
  }
  async snapshot(
    review: Pick<TransactionReview, "wallet" | "usdcAccount" | "wsolAccount" | "asset" | "tokenAccount">,
    minSlot?: string,
  ): Promise<WalletSnapshot> {
    if (JSON.stringify(reviewAsset(review)) !== JSON.stringify(this.asset)) throw Error("NETWORK_ASSET_BINDING");
    const tokenAddress = reviewTokenAccount(review);
    const r = await this.rpc("getMultipleAccounts", [
      [review.wallet, tokenAddress, review.wsolAccount],
      {
        encoding: "base64",
        commitment: "finalized",
        ...(minSlot ? { minContextSlot: Number(minSlot) } : {}),
      },
    ]);
    if (r.value[0]?.owner !== PROGRAM_IDS.SYSTEM || r.value[0]?.executable)
      throw new Error("WALLET_NOT_SYSTEM_ACCOUNT");
    const usdc = tokenAccount(r.value[1], review.wallet, this.asset.tokenMint);
    const owned = await this.rpc("getTokenAccountsByOwner", [
      review.wallet,
      { programId: PROGRAM_IDS.TOKEN },
      {
        encoding: "base64",
        commitment: "finalized",
        minContextSlot: Number(r.context.slot),
      },
    ]);
    for (const a of owned.value as Obj[]) {
      if (a.pubkey === tokenAddress) continue;
      // A completed dynamic FULL SELL leaves an empty ATA. It is not a position,
      // but only canonical inert classic ATAs may survive into the next episode.
      // Manual retains its original dedicated-USDC-only wallet requirement.
      if (!review.asset) throw Error("WALLET_NOT_DEDICATED_OR_EXTRA_TOKEN_ACCOUNTS");
      const data = Buffer.from(a.account?.data?.[0] ?? "", "base64");
      if (data.length !== 165 || a.account.executable !== false)
        throw Error("WALLET_NOT_DEDICATED_OR_EXTRA_TOKEN_ACCOUNTS");
      const mint = bs58.encode(data.subarray(0, 32));
      const inert = tokenAccount(a.account, review.wallet, mint);
      if (mint === WSOL_MINT || inert.amount !== "0" ||
          a.pubkey !== await associatedAccount(review.wallet, mint))
        throw Error("WALLET_NOT_DEDICATED_OR_EXTRA_TOKEN_ACCOUNTS");
    }
    const extensions = await this.rpc("getTokenAccountsByOwner", [
      review.wallet,
      { programId: PROGRAM_IDS.TOKEN_2022 },
      {
        encoding: "base64",
        commitment: "finalized",
        minContextSlot: Number(r.context.slot),
      },
    ]);
    if (extensions.value.length !== 0)
      throw new Error("WALLET_HAS_TOKEN_2022_ACCOUNTS");
    return {
      slot: raw(r.context.slot),
      walletLamports: raw(r.value[0].lamports),
      usdcRaw: this.asset.tokenMint === USDC_MINT ? usdc.amount : "0",
      usdcRentLamports: this.asset.tokenMint === USDC_MINT ? usdc.rent : "0",
      ...(review.asset ? { tokenMint: this.asset.tokenMint, tokenRaw: usdc.amount, tokenRentLamports: usdc.rent } : {}),
      wsolAbsent: r.value[2] === null,
    };
  }
  async simulate(
    transaction: string,
    review: TransactionReview,
  ): Promise<Simulation> {
    if (JSON.stringify(reviewAsset(review)) !== JSON.stringify(this.asset)) throw Error("NETWORK_ASSET_BINDING");
    const wire = decodeWire(transaction);
    const message = Buffer.from(wire.transaction.messageBytes).toString("base64");
    const signed = Object.values(wire.transaction.signatures).some(signature =>
      signature !== null && signature.some(byte => byte !== 0));
    const independentContextSlot = (review as TransactionReview & { independentContextSlot?: number }).independentContextSlot;
    const f = await this.rpc("getFeeForMessage", [
      message,
      { commitment: "confirmed", ...(independentContextSlot !== undefined ? { minContextSlot: independentContextSlot } : {}) },
    ]);
    if (f.value === null) throw new Error("FEE_OR_BLOCKHASH_UNAVAILABLE");
    const r = await this.rpc("simulateTransaction", [
      transaction,
      {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: signed,
        replaceRecentBlockhash: false,
        ...(independentContextSlot !== undefined ? { minContextSlot: independentContextSlot } : {}),
        accounts: {
          encoding: "base64",
          addresses: [review.wallet, reviewTokenAccount(review), review.wsolAccount],
        },
      },
    ]);
    if (
      r.value.err !== null ||
      !r.value.accounts ||
      !Array.isArray(r.value.logs)
    )
      throw new UnsignedSimulationError({
        slot: r.context.slot,
        error: r.value.err,
        logs: r.value.logs,
        unitsConsumed: r.value.unitsConsumed,
      });
    if (r.value.accounts[0]?.owner !== PROGRAM_IDS.SYSTEM)
      throw new Error("SIMULATION_WALLET_OWNER");
    const usdc = tokenAccount(r.value.accounts[1], review.wallet, this.asset.tokenMint);
    return {
      slot: raw(r.context.slot),
      feeLamports: raw(f.value),
      walletAfterLamports: raw(r.value.accounts[0].lamports),
      tokenAfterRaw: usdc.amount,
      rentAfterLamports: usdc.rent,
      wsolClosed: simulatedWsolClosed(r.value.accounts[2]),
      logs: r.value.logs,
    };
  }
  async blockhashValid(blockhash: string): Promise<boolean> {
    return (
      (
        await this.rpc("isBlockhashValid", [
          blockhash,
          { commitment: "confirmed" },
        ])
      ).value === true
    );
  }
  async execute(
    signedTransaction: string,
    requestId: string,
  ): Promise<unknown> {
    return this.jupiter("execute", "POST", { signedTransaction, requestId });
  }
  async finalizedTransaction(signature: string): Promise<unknown | null> {
    return this.rpc("getTransaction", [
      signature,
      {
        encoding: "base64",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ]);
  }
  async signatureStatus(signature: string): Promise<unknown> {
    return this.rpc("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
  }
}
