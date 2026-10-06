import { Decimal } from "decimal.js";
import type { ExecutionIntent } from "../domain/execution.js";
import type { SwapEvent } from "../domain/trades.js";
import { JupiterRequestError } from "../execution/jupiter-order-adapter.js";
import type { PaperQuoteObserver } from "../execution/paper-transaction-sender.js";
import type { JupiterQuoteTelemetry } from "./types.js";
import type { ValidationStore } from "./validation-store.js";

interface QuoteContext {
  readonly validationEventId: string;
  readonly event: SwapEvent;
  readonly provider: string;
}

function normalizedPrice(
  quoteRaw: bigint,
  quoteDecimals: number,
  tokenRaw: bigint,
  tokenDecimals: number,
): Decimal | undefined {
  if (tokenRaw <= 0n || quoteRaw < 0n) return undefined;
  return new Decimal(quoteRaw.toString())
    .div(new Decimal(10).pow(quoteDecimals))
    .div(
      new Decimal(tokenRaw.toString()).div(new Decimal(10).pow(tokenDecimals)),
    );
}

export class ShadowQuoteRecorder implements PaperQuoteObserver {
  private readonly contexts = new Map<string, QuoteContext>();
  private readonly observations = new Map<string, JupiterQuoteTelemetry>();

  constructor(private readonly store: ValidationStore) {}

  register(
    executionKey: string,
    validationEventId: string,
    event: SwapEvent,
    provider: string,
  ): void {
    this.contexts.set(executionKey, { validationEventId, event, provider });
  }

  observe(
    intent: ExecutionIntent,
    outcome: Parameters<PaperQuoteObserver["observe"]>[1],
  ): void {
    const context = this.contexts.get(intent.executionKey);
    if (!context) return;
    this.contexts.delete(intent.executionKey);
    const { event } = context;
    const source = normalizedPrice(
      event.quote.raw,
      event.quote.decimals,
      event.token.raw,
      event.token.decimals,
    );
    let telemetry: JupiterQuoteTelemetry;
    if (outcome.ok) {
      const order = outcome.order;
      const expected =
        event.side === "BUY"
          ? normalizedPrice(
              order.inputRaw,
              event.quote.decimals,
              order.expectedOutputRaw,
              event.token.decimals,
            )
          : normalizedPrice(
              order.expectedOutputRaw,
              event.quote.decimals,
              order.inputRaw,
              event.token.decimals,
            );
      const difference =
        source && expected && !source.isZero()
          ? expected.minus(source).div(source).mul(100)
          : undefined;
      const adverse = difference
        ? event.side === "BUY"
          ? Decimal.max(difference, 0)
          : Decimal.max(difference.negated(), 0)
        : undefined;
      telemetry = {
        validationEventId: context.validationEventId,
        executionKey: intent.executionKey,
        requestTimestampMs: order.requestTimestampMs,
        responseTimestampMs: order.responseTimestampMs,
        requestMonotonicNs: order.requestMonotonicNs,
        responseMonotonicNs: order.responseMonotonicNs,
        httpStatus: order.httpStatus,
        schemaValid: order.schemaValid,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        inputRaw: order.inputRaw,
        expectedOutputRaw: order.expectedOutputRaw,
        router: order.router,
        route: order.route,
        ...(order.priceImpactPct === undefined
          ? {}
          : { priceImpactPct: order.priceImpactPct }),
        ...(source === undefined ? {} : { sourcePrice: source.toString() }),
        ...(expected === undefined
          ? {}
          : { expectedExecutionPrice: expected.toString() }),
        ...(difference === undefined
          ? {}
          : { theoreticalPriceDifferencePct: difference.toString() }),
        ...(adverse === undefined
          ? {}
          : { adversePriceDifferencePct: adverse.toString() }),
        provider: context.provider,
        dex: event.dex,
        tokenMint: event.token.mint,
        leader: event.leaderWallet,
        observedHour: new Date(order.responseTimestampMs)
          .toISOString()
          .slice(0, 13),
      };
    } else {
      const failure =
        outcome.error instanceof JupiterRequestError
          ? outcome.error.telemetry
          : {
              requestTimestampMs: Date.now(),
              requestMonotonicNs: process.hrtime.bigint(),
              schemaValid: false,
            };
      telemetry = {
        validationEventId: context.validationEventId,
        executionKey: intent.executionKey,
        requestTimestampMs: failure.requestTimestampMs,
        ...(failure.responseTimestampMs === undefined
          ? {}
          : { responseTimestampMs: failure.responseTimestampMs }),
        requestMonotonicNs: failure.requestMonotonicNs,
        ...(failure.responseMonotonicNs === undefined
          ? {}
          : { responseMonotonicNs: failure.responseMonotonicNs }),
        ...(failure.httpStatus === undefined
          ? {}
          : { httpStatus: failure.httpStatus }),
        schemaValid: failure.schemaValid,
        inputMint: event.side === "BUY" ? event.quote.mint : event.token.mint,
        outputMint: event.side === "BUY" ? event.token.mint : event.quote.mint,
        inputRaw:
          event.side === "BUY"
            ? intent.theoreticalQuoteRaw
            : intent.theoreticalTokenRaw,
        provider: context.provider,
        dex: event.dex,
        tokenMint: event.token.mint,
        leader: event.leaderWallet,
        observedHour: new Date(
          failure.responseTimestampMs ?? failure.requestTimestampMs,
        )
          .toISOString()
          .slice(0, 13),
        failureReason:
          outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error),
      };
    }
    this.observations.set(intent.executionKey, telemetry);
    void this.store.saveJupiterQuote(telemetry);
  }

  take(executionKey: string): JupiterQuoteTelemetry | undefined {
    const observation = this.observations.get(executionKey);
    this.observations.delete(executionKey);
    return observation;
  }
}
