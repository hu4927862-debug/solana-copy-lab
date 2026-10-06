import { z } from "zod";
import bs58 from "bs58";
import type { JupiterPriceImpactEvidence } from "../domain/execution.js";
import { normalizeJupiterPriceImpact } from "./jupiter-price-impact.js";
import {
  canonicalDomainQuoteMint,
  NATIVE_SOL,
  WSOL_MINT,
} from "../domain/assets.js";
import { SystemClock, type Clock } from "../domain/time.js";
import { JupiterPacingRejectedError } from "../network/jupiter-request-pacer.js";

const RawAmountSchema = z.string().regex(/^\d+$/);
const FeeBpsSchema = z.number().int().nonnegative().safe();
const SolanaMintSchema = z.string().refine((value) => {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
});
const PlatformFeeSchema = z.object({
  amount: RawAmountSchema,
  feeBps: FeeBpsSchema,
  feeMint: SolanaMintSchema,
});

function normalizeJupiterMint(mint: string): string {
  return mint === NATIVE_SOL ? WSOL_MINT : mint;
}

const JupiterOrderResponseSchema = z
  .object({
    transaction: z.string().nullable(),
    requestId: z.string().min(1),
    outAmount: RawAmountSchema,
    inAmount: RawAmountSchema,
    inputMint: z.string().min(32),
    outputMint: z.string().min(32),
    router: z.string().min(1),
    mode: z.string().min(1),
    feeBps: FeeBpsSchema,
    feeMint: z.string().min(32),
    platformFee: z.unknown().optional(),
    priceImpactPct: z.unknown().optional(),
    priceImpact: z.unknown().optional(),
    routePlan: z.array(z.unknown()).optional(),
    errorCode: z.number().int().optional(),
    errorMessage: z.string().optional(),
  })
  .passthrough();

export interface JupiterOrderRequest {
  readonly signal?: AbortSignal;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amount: bigint;
  readonly taker?: string;
}

export interface JupiterOrder {
  readonly requestId: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputRaw: bigint;
  readonly expectedOutputRaw: bigint;
  readonly router: string;
  readonly mode: string;
  readonly feeBps: number;
  readonly feeMint: string;
  readonly platformFee?: {
    readonly amountRaw: bigint;
    readonly feeBps: number;
    readonly feeMint: string;
  };
  readonly platformFeeDiagnostic?: import("../domain/execution.js").FeeEvidenceUnavailableReason;
  readonly priceImpactPct?: string;
  readonly priceImpactEvidence?: JupiterPriceImpactEvidence;
  readonly providerEvidence?: Readonly<Record<string, unknown>>;
  readonly route: readonly unknown[];
  readonly responseTimestampMs: number;
  readonly requestTimestampMs: number;
  readonly requestMonotonicNs: bigint;
  readonly responseMonotonicNs: bigint;
  readonly httpStatus: number;
  readonly schemaValid: true;
  readonly hasAssembledTransaction: boolean;
}

export interface JupiterOrderProvider {
  getOrder(request: JupiterOrderRequest): Promise<JupiterOrder>;
}

export interface JupiterFailureTelemetry {
  readonly requestTimestampMs: number;
  readonly responseTimestampMs?: number;
  readonly requestMonotonicNs: bigint;
  readonly responseMonotonicNs?: bigint;
  readonly httpStatus?: number;
  readonly schemaValid: boolean;
  readonly transportPhase?: "FETCH_HEADERS" | "READ_BODY";
  readonly transportErrorCode?: string;
}

function transportErrorCode(error: unknown, depth = 0): string | undefined {
  if (!(error instanceof Error) || depth > 3) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  // Only transport codes are retained; never copy URLs, headers or cause text.
  if (
    typeof code === "string" &&
    /^(?:E(?:CONNRESET|CONNREFUSED|TIMEDOUT|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH|PIPE)|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|ERR_TLS_(?:CERT_ALTNAME_INVALID|HANDSHAKE_TIMEOUT)|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(
      code,
    )
  )
    return code;
  if (error.name === "TimeoutError") return "TIMEOUT";
  if (error.name === "AbortError") return "ABORTED";
  return transportErrorCode(error.cause, depth + 1);
}

export class JupiterRequestError extends Error {
  constructor(
    message: string,
    readonly telemetry: JupiterFailureTelemetry,
  ) {
    super(message);
  }
}

export class JupiterSchemaError extends JupiterRequestError {
  constructor(
    readonly issues: readonly unknown[],
    telemetry: JupiterFailureTelemetry,
  ) {
    super("Jupiter /swap/v2/order returned an invalid schema", telemetry);
  }
}

export class JupiterTransportError extends JupiterRequestError {
  constructor(
    error: unknown,
    phase: "FETCH_HEADERS" | "READ_BODY",
    telemetry: JupiterFailureTelemetry,
  ) {
    const code = transportErrorCode(error);
    super(`Jupiter transport failed: ${phase}${code ? `:${code}` : ""}`, {
      ...telemetry,
      transportPhase: phase,
      ...(code ? { transportErrorCode: code } : {}),
    });
    this.name = "JupiterTransportError";
  }
}

export class JupiterLocalPacingError extends JupiterRequestError {
  constructor(telemetry: JupiterFailureTelemetry) {
    super("JUPITER_LOCAL_RATE_LIMIT", telemetry);
    this.name = "JupiterLocalPacingError";
  }
}

export class JupiterOrderAdapter implements JupiterOrderProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.jup.ag/swap/v2",
    private readonly clock: Clock = new SystemClock(),
  ) {
    if (!apiKey) throw new Error("Jupiter API key is required");
  }

  async getOrder(request: JupiterOrderRequest): Promise<JupiterOrder> {
    if (request.amount <= 0n)
      throw new Error("Jupiter order amount must be positive");
    const query = new URLSearchParams({
      inputMint: normalizeJupiterMint(request.inputMint),
      outputMint: normalizeJupiterMint(request.outputMint),
      amount: request.amount.toString(),
      ...(request.taker === undefined ? {} : { taker: request.taker }),
    });
    const started = this.clock.now();
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/order?${query.toString()}`,
        {
          method: "GET",
          headers: { "x-api-key": this.apiKey, accept: "application/json" },
          signal: AbortSignal.any([
            AbortSignal.timeout(3_000),
            ...(request.signal ? [request.signal] : []),
          ]),
        },
      );
    } catch (error) {
      const failed = this.clock.now();
      if (error instanceof JupiterPacingRejectedError) {
        throw new JupiterLocalPacingError({
          requestTimestampMs: started.wallMs,
          responseTimestampMs: failed.wallMs,
          requestMonotonicNs: started.monotonicNs,
          responseMonotonicNs: failed.monotonicNs,
          schemaValid: false,
        });
      }
      throw new JupiterTransportError(error, "FETCH_HEADERS", {
        requestTimestampMs: started.wallMs,
        responseTimestampMs: failed.wallMs,
        requestMonotonicNs: started.monotonicNs,
        responseMonotonicNs: failed.monotonicNs,
        schemaValid: false,
      });
    }
    const responded = this.clock.now();
    if (!response.ok) {
      throw new JupiterRequestError(
        `Jupiter order failed with HTTP ${response.status}`,
        {
          requestTimestampMs: started.wallMs,
          responseTimestampMs: responded.wallMs,
          requestMonotonicNs: started.monotonicNs,
          responseMonotonicNs: responded.monotonicNs,
          httpStatus: response.status,
          schemaValid: false,
        },
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      const telemetry: JupiterFailureTelemetry = {
        requestTimestampMs: started.wallMs,
        responseTimestampMs: this.clock.now().wallMs,
        requestMonotonicNs: started.monotonicNs,
        responseMonotonicNs: this.clock.now().monotonicNs,
        httpStatus: response.status,
        schemaValid: false,
      };
      if (transportErrorCode(error) !== undefined)
        throw new JupiterTransportError(error, "READ_BODY", telemetry);
      throw new JupiterSchemaError([], telemetry);
    }
    const parsed = JupiterOrderResponseSchema.safeParse(payload);
    const parsedAt = this.clock.now();
    if (!parsed.success)
      throw new JupiterSchemaError(parsed.error.issues, {
        requestTimestampMs: started.wallMs,
        responseTimestampMs: parsedAt.wallMs,
        requestMonotonicNs: started.monotonicNs,
        responseMonotonicNs: parsedAt.monotonicNs,
        httpStatus: response.status,
        schemaValid: false,
      });
    if (parsed.data.errorCode !== undefined || parsed.data.transaction === "") {
      throw new JupiterRequestError(
        `Jupiter order unavailable: ${parsed.data.errorMessage ?? parsed.data.errorCode ?? "unknown"}`,
        {
          requestTimestampMs: started.wallMs,
          responseTimestampMs: parsedAt.wallMs,
          requestMonotonicNs: started.monotonicNs,
          responseMonotonicNs: parsedAt.monotonicNs,
          httpStatus: response.status,
          schemaValid: true,
        },
      );
    }
    if (
      parsed.data.inputMint !== normalizeJupiterMint(request.inputMint) ||
      parsed.data.outputMint !== normalizeJupiterMint(request.outputMint) ||
      BigInt(parsed.data.inAmount) !== request.amount
    ) {
      throw new JupiterSchemaError(["RESPONSE_REQUEST_BINDING_MISMATCH"], {
        requestTimestampMs: started.wallMs,
        responseTimestampMs: parsedAt.wallMs,
        requestMonotonicNs: started.monotonicNs,
        responseMonotonicNs: parsedAt.monotonicNs,
        httpStatus: response.status,
        schemaValid: false,
      });
    }
    const platformFee = PlatformFeeSchema.safeParse(parsed.data.platformFee);
    const platformFeeDiagnostic =
      parsed.data.platformFee === undefined
        ? "PLATFORM_FEE_MISSING"
        : platformFee.success
          ? undefined
          : "PLATFORM_FEE_SCHEMA_INVALID";
    const priceImpactEvidence = normalizeJupiterPriceImpact({
      ...(parsed.data.priceImpact === undefined
        ? {}
        : { priceImpact: parsed.data.priceImpact }),
      ...(parsed.data.priceImpactPct === undefined
        ? {}
        : { priceImpactPct: parsed.data.priceImpactPct }),
    });
    return {
      requestId: parsed.data.requestId,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputRaw: request.amount,
      expectedOutputRaw: BigInt(parsed.data.outAmount),
      router: parsed.data.router,
      mode: parsed.data.mode,
      feeBps: parsed.data.feeBps,
      feeMint: canonicalDomainQuoteMint(parsed.data.feeMint),
      ...(!platformFee.success
        ? {}
        : {
            platformFee: {
              amountRaw: BigInt(platformFee.data.amount),
              feeBps: platformFee.data.feeBps,
              feeMint: canonicalDomainQuoteMint(platformFee.data.feeMint),
            },
          }),
      ...(platformFeeDiagnostic === undefined ? {} : { platformFeeDiagnostic }),
      priceImpactEvidence,
      // Selected raw contract evidence, never transaction bytes or credentials.
      // Fee estimates and payer hints do not establish actual execution cost.
      providerEvidence: Object.fromEntries(
        [
          "inputMint",
          "outputMint",
          "inAmount",
          "outAmount",
          "feeBps",
          "feeMint",
          "platformFee",
          "inUsdValue",
          "outUsdValue",
          "swapUsdValue",
          "signatureFeeLamports",
          "signatureFeePayer",
          "prioritizationFeeLamports",
          "prioritizationFeePayer",
          "rentFeeLamports",
          "rentFeePayer",
          "gasless",
          "taker",
          "slippageBps",
          "otherAmountThreshold",
          "swapMode",
        ]
          .filter((key) => parsed.data[key] !== undefined)
          .map((key) => [key, parsed.data[key]]),
      ),
      ...(priceImpactEvidence.normalizedPct === undefined
        ? {}
        : { priceImpactPct: priceImpactEvidence.normalizedPct }),
      route: parsed.data.routePlan ?? [],
      requestTimestampMs: started.wallMs,
      responseTimestampMs: parsedAt.wallMs,
      requestMonotonicNs: started.monotonicNs,
      responseMonotonicNs: parsedAt.monotonicNs,
      httpStatus: response.status,
      schemaValid: true,
      hasAssembledTransaction: Boolean(parsed.data.transaction),
    };
  }
}
