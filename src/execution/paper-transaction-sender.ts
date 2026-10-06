import { Decimal } from "decimal.js";
import type {
  ExecutionIntent,
  ExecutionResult,
  PaperQuoteEvidence,
  QuoteFeeEvidence,
} from "../domain/execution.js";
import { FEE_EVIDENCE_CONTRACT_V1 } from "../domain/execution.js";
import type { TransactionSender } from "../domain/ports.js";
import {
  JupiterRequestError,
  JupiterLocalPacingError,
  JupiterSchemaError,
  JupiterTransportError,
  type JupiterOrder,
  type JupiterOrderProvider,
} from "./jupiter-order-adapter.js";

function classifyUntypedProviderError(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN_PROVIDER_ERROR";
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|network|timeout/i.test(
    error.message,
  )
    ? "TIMEOUT_NETWORK"
    : "UNKNOWN_PROVIDER_ERROR";
}

export interface PaperLedger {
  readonly results: Map<string, ExecutionResult>;
}

export interface PaperQuoteObserver {
  observe(
    intent: ExecutionIntent,
    outcome:
      | { readonly ok: true; readonly order: JupiterOrder }
      | { readonly ok: false; readonly error: unknown },
  ): void | Promise<void>;
}

function resolveQuoteFeeEvidence(
  order: JupiterOrder,
  quoteMint: string,
): QuoteFeeEvidence {
  const common = {
    contractVersion: FEE_EVIDENCE_CONTRACT_V1,
    sourceType: "JUPITER_SWAP_V2_ORDER_RESPONSE" as const,
    sourceVersion: "JUPITER_SWAP_API_V2_OPENAPI_2_0_0" as const,
    feeType: "JUPITER_PLATFORM_FEE" as const,
    totalFeeBps: order.feeBps,
    totalFeeMint: order.feeMint,
    amountBasis: "PROVIDER_REPORTED_FEE_MINT_AMOUNT" as const,
    roundingMode: "PROVIDER_FINAL_INTEGER_NO_LOCAL_ROUNDING" as const,
    includedInQuotedAmount: true as const,
  };
  const platform = order.platformFee;
  if (platform === undefined)
    return {
      ...common,
      status: "AMOUNT_UNAVAILABLE",
      unavailableReason: order.platformFeeDiagnostic ?? "PLATFORM_FEE_MISSING",
    };
  if (order.feeBps < platform.feeBps)
    return {
      ...common,
      status: "AMOUNT_UNAVAILABLE",
      unavailableReason: "FEE_BPS_MISMATCH",
    };
  if (order.feeMint !== platform.feeMint)
    return {
      ...common,
      status: "AMOUNT_UNAVAILABLE",
      unavailableReason: "FEE_MINT_MISMATCH",
    };
  if (platform.feeMint !== quoteMint)
    return {
      ...common,
      status: "AMOUNT_UNAVAILABLE",
      unavailableReason: "NON_QUOTE_FEE_MINT",
    };
  return {
    ...common,
    status: "AVAILABLE",
    feeAmountRaw: platform.amountRaw,
    feeBps: platform.feeBps,
    feeMint: platform.feeMint,
  };
}

export class PaperTransactionSender implements TransactionSender {
  readonly mode = "PAPER" as const;

  constructor(
    private readonly orderProvider?: JupiterOrderProvider,
    private readonly ledger: PaperLedger = { results: new Map() },
    private readonly quoteObserver?: PaperQuoteObserver,
  ) {}

  async send(
    intent: ExecutionIntent,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExecutionResult> {
    if (
      process.env.PAPER_ONLY !== "true" ||
      process.env.LIVE_FUNDS_ENABLED !== "false"
    ) {
      return {
        executionKey: intent.executionKey,
        state: "FAILED",
        executedTokenRaw: 0n,
        executedQuoteRaw: 0n,
        reason: "PAPER_TRADING_SAFETY_CONFIG_INVALID",
      };
    }
    const previous = this.ledger.results.get(intent.executionKey);
    if (previous) return previous;
    if (intent.skipReason) {
      const skipped: ExecutionResult = {
        executionKey: intent.executionKey,
        state: "SKIPPED",
        executedTokenRaw: 0n,
        executedQuoteRaw: 0n,
        reason: intent.skipReason,
      };
      this.ledger.results.set(intent.executionKey, skipped);
      return skipped;
    }
    if (!this.orderProvider) {
      const failed: ExecutionResult = {
        executionKey: intent.executionKey,
        state: "FAILED",
        executedTokenRaw: 0n,
        executedQuoteRaw: 0n,
        reason: "PAPER_FILL_QUOTE_REQUIRED",
      };
      this.ledger.results.set(intent.executionKey, failed);
      return failed;
    }

    let tokenRaw = intent.theoreticalTokenRaw;
    let quoteRaw = intent.theoreticalQuoteRaw;
    let executionPrice: string | undefined;
    let metadata: Readonly<Record<string, unknown>> | undefined;
    let paperQuoteEvidence: PaperQuoteEvidence | undefined;
    try {
      options?.signal?.throwIfAborted();
      const buy = intent.side === "BUY";
      const requestedInputMint = buy ? intent.quoteMint : intent.tokenMint;
      const requestedOutputMint = buy ? intent.tokenMint : intent.quoteMint;
      const requestedAmount = buy ? quoteRaw : tokenRaw;
      const order = await this.orderProvider.getOrder({
        inputMint: requestedInputMint,
        outputMint: requestedOutputMint,
        amount: requestedAmount,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      options?.signal?.throwIfAborted();
      if (
        order.schemaValid !== true ||
        order.inputMint !== requestedInputMint ||
        order.outputMint !== requestedOutputMint ||
        order.inputRaw !== requestedAmount ||
        order.expectedOutputRaw <= 0n ||
        order.httpStatus < 200 ||
        order.httpStatus >= 300
      ) {
        throw new JupiterSchemaError([], {
          requestTimestampMs: order.requestTimestampMs,
          responseTimestampMs: order.responseTimestampMs,
          requestMonotonicNs: order.requestMonotonicNs,
          responseMonotonicNs: order.responseMonotonicNs,
          httpStatus: order.httpStatus,
          schemaValid: false,
        });
      }
      await this.quoteObserver?.observe(intent, { ok: true, order });
      if (buy) tokenRaw = order.expectedOutputRaw;
      else quoteRaw = order.expectedOutputRaw;
      const feeEvidence = resolveQuoteFeeEvidence(order, intent.quoteMint);
      paperQuoteEvidence = {
        provider: "JUPITER_SWAP_V2_ORDER",
        requestId: order.requestId,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        inputAmountRaw: order.inputRaw,
        outputAmountRaw: order.expectedOutputRaw,
        requestTimestampMs: order.requestTimestampMs,
        responseTimestampMs: order.responseTimestampMs,
        requestMonotonicNs: order.requestMonotonicNs,
        responseMonotonicNs: order.responseMonotonicNs,
        httpStatus: order.httpStatus,
        schemaValid: true,
        feeBps: order.feeBps,
        feeMint: order.feeMint,
        feeEvidence,
        router: order.router,
        mode: order.mode,
        ...(order.priceImpactPct === undefined
          ? {}
          : { priceImpactPct: order.priceImpactPct }),
        route: order.route,
        ...(order.providerEvidence === undefined
          ? {}
          : { providerEvidence: order.providerEvidence }),
        ...(order.priceImpactEvidence === undefined
          ? {}
          : { priceImpactEvidence: order.priceImpactEvidence }),
      };
      metadata = {
        provider: "JUPITER_SWAP_V2_ORDER",
        requestId: order.requestId,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        inputRaw: order.inputRaw.toString(),
        expectedOutputRaw: order.expectedOutputRaw.toString(),
        router: order.router,
        mode: order.mode,
        feeBps: order.feeBps,
        feeMint: order.feeMint,
        feeEvidence: {
          ...feeEvidence,
          ...(feeEvidence.status === "AVAILABLE"
            ? { feeAmountRaw: feeEvidence.feeAmountRaw.toString() }
            : {}),
        },
        priceImpactPct: order.priceImpactPct,
        priceImpactEvidence: order.priceImpactEvidence,
        providerEvidence: order.providerEvidence,
        route: order.route,
        responseTimestampMs: order.responseTimestampMs,
        requestTimestampMs: order.requestTimestampMs,
        requestMonotonicNs: order.requestMonotonicNs.toString(),
        responseMonotonicNs: order.responseMonotonicNs.toString(),
        httpStatus: order.httpStatus,
        schemaValid: order.schemaValid,
        hasAssembledTransaction: order.hasAssembledTransaction,
      };
    } catch (error) {
      await this.quoteObserver?.observe(intent, { ok: false, error });
      const failed: ExecutionResult = {
        executionKey: intent.executionKey,
        state: "FAILED",
        executedTokenRaw: 0n,
        executedQuoteRaw: 0n,
        reason:
          error instanceof JupiterSchemaError
            ? "JUPITER_SCHEMA_INVALID"
            : error instanceof JupiterRequestError
              ? "JUPITER_ORDER_FAILED"
              : "JUPITER_ORDER_FAILED",
        ...(error instanceof JupiterLocalPacingError
          ? {
              metadata: {
                failureCategory: "LOCAL_PACING_REJECT",
                localRejectReason: "JUPITER_LOCAL_RATE_LIMIT",
              },
            }
          : error instanceof JupiterTransportError
            ? {
                metadata: {
                  failureCategory: "TIMEOUT_NETWORK",
                  transportPhase: error.telemetry.transportPhase,
                  ...(error.telemetry.transportErrorCode === undefined
                    ? {}
                    : {
                        transportErrorCode: error.telemetry.transportErrorCode,
                      }),
                  ...(error.telemetry.httpStatus === undefined
                    ? {}
                    : { httpStatus: error.telemetry.httpStatus }),
                },
              }
            : error instanceof JupiterRequestError &&
                error.telemetry.httpStatus !== undefined
              ? {
                  metadata: {
                    httpStatus: error.telemetry.httpStatus,
                    failureCategory:
                      error instanceof JupiterSchemaError
                        ? "MALFORMED_INVALID_ORDER_RESPONSE"
                        : error.telemetry.httpStatus >= 500
                          ? "PROVIDER_UNAVAILABLE"
                          : "PROVIDER_REJECTION",
                  },
                }
              : {
                  metadata: {
                    failureCategory:
                      error instanceof JupiterSchemaError
                        ? "MALFORMED_INVALID_ORDER_RESPONSE"
                        : classifyUntypedProviderError(error),
                  },
                }),
      };
      this.ledger.results.set(intent.executionKey, failed);
      return failed;
    }
    if (tokenRaw > 0n)
      executionPrice = new Decimal(quoteRaw.toString())
        .div(tokenRaw.toString())
        .toString();
    const now = Date.now();
    const result: ExecutionResult = {
      executionKey: intent.executionKey,
      state: "PAPER_EXECUTED",
      executedTokenRaw: tokenRaw,
      executedQuoteRaw: quoteRaw,
      ...(executionPrice === undefined ? {} : { executionPrice }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(paperQuoteEvidence === undefined ? {} : { paperQuoteEvidence }),
      sentAtMs: now,
      confirmedAtMs: now,
    };
    this.ledger.results.set(intent.executionKey, result);
    return result;
  }

  async lookup(executionKey: string): Promise<ExecutionResult | undefined> {
    return this.ledger.results.get(executionKey);
  }
}
