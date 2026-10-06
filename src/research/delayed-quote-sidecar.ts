import PQueue from "p-queue";
import type {
  JupiterOrderProvider,
  JupiterRequestError,
} from "../execution/jupiter-order-adapter.js";
import {
  JupiterRequestError as JupiterRequestFailure,
  JupiterSchemaError,
} from "../execution/jupiter-order-adapter.js";
import type {
  DelayedQuoteEvidence,
  DelayedQuoteEvidenceSink,
  DelayedQuoteFailureCode,
  FirstQuoteResearchParent,
} from "../persistence/execution-realism-evidence-store.js";
import type { ExecutionRealismDelayPolicy } from "./execution-realism-policy.js";

export interface DelayController {
  nowMs(): number;
  waitUntil(timestampMs: number): Promise<void>;
}

export class SystemDelayController implements DelayController {
  nowMs(): number {
    return Date.now();
  }

  async waitUntil(timestampMs: number): Promise<void> {
    const remainingMs = Math.max(0, timestampMs - Date.now());
    if (remainingMs === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
  }
}

export interface ExecutionRealismSidecar {
  enqueue(parent: FirstQuoteResearchParent): void;
  drain(): Promise<void>;
}

export interface DelayedQuoteSidecarFailureContext {
  readonly parentExecutionKey: string;
  readonly intendedDelayMs: number;
}

type DelayCapturePolicy = Omit<
  ExecutionRealismDelayPolicy,
  "delayOffsetsMs"
> & {
  readonly delayOffsetsMs: readonly (3_000 | 10_000)[];
};

function failureCode(error: unknown): DelayedQuoteFailureCode {
  if (error instanceof JupiterSchemaError) return "SCHEMA_INVALID";
  if (error instanceof JupiterRequestFailure) {
    if (error.telemetry.httpStatus !== undefined) return "HTTP_ERROR";
    if (/abort|timeout|timed out/i.test(error.message)) return "TIMEOUT";
    return "REQUEST_FAILED";
  }
  return "UNEXPECTED_ERROR";
}

function requestTelemetry(
  error: unknown,
): JupiterRequestError["telemetry"] | undefined {
  return error instanceof JupiterRequestFailure ? error.telemetry : undefined;
}

export class DelayedQuoteSidecar implements ExecutionRealismSidecar {
  private readonly requestQueue = new PQueue({ concurrency: 1 });
  private readonly scheduled = new Set<Promise<void>>();

  constructor(
    private readonly provider: JupiterOrderProvider,
    private readonly store: DelayedQuoteEvidenceSink,
    private readonly policy: DelayCapturePolicy,
    private readonly delay: DelayController = new SystemDelayController(),
    private readonly onFailure?: (
      error: unknown,
      context: DelayedQuoteSidecarFailureContext,
    ) => void,
  ) {}

  enqueue(parent: FirstQuoteResearchParent): void {
    for (const intendedDelayMs of this.policy.delayOffsetsMs) {
      if (
        this.store.has(
          parent.executionKey,
          this.policy.policyVersion,
          intendedDelayMs,
        )
      )
        continue;
      const scheduled = this.schedule(parent, intendedDelayMs).catch(
        (error: unknown) => {
          try {
            this.onFailure?.(error, {
              parentExecutionKey: parent.executionKey,
              intendedDelayMs,
            });
          } catch {
            // A research observer must not turn a contained sidecar failure
            // into an unhandled pipeline error.
          }
        },
      );
      this.scheduled.add(scheduled);
      void scheduled.then(() => this.scheduled.delete(scheduled));
    }
  }

  async drain(): Promise<void> {
    while (this.scheduled.size > 0)
      await Promise.allSettled([...this.scheduled]);
    await this.requestQueue.onIdle();
  }

  private async schedule(
    parent: FirstQuoteResearchParent,
    intendedDelayMs: number,
  ): Promise<void> {
    await this.delay.waitUntil(parent.referenceTimestampMs + intendedDelayMs);
    await this.requestQueue.add(async () => {
      if (
        this.store.has(
          parent.executionKey,
          this.policy.policyVersion,
          intendedDelayMs,
        )
      )
        return;
      await this.capture(parent, intendedDelayMs);
    });
  }

  private async capture(
    parent: FirstQuoteResearchParent,
    intendedDelayMs: number,
  ): Promise<void> {
    const fallbackRequestTimestampMs = this.delay.nowMs();
    let evidence: DelayedQuoteEvidence;
    try {
      const order = await this.provider.getOrder({
        inputMint: parent.inputMint,
        outputMint: parent.outputMint,
        amount: parent.inputAmountRaw,
      });
      if (
        order.inputMint !== parent.inputMint ||
        order.outputMint !== parent.outputMint ||
        order.inputRaw !== parent.inputAmountRaw ||
        order.expectedOutputRaw <= 0n ||
        order.schemaValid !== true ||
        order.httpStatus < 200 ||
        order.httpStatus >= 300
      )
        throw new JupiterSchemaError([], {
          requestTimestampMs: order.requestTimestampMs,
          responseTimestampMs: order.responseTimestampMs,
          requestMonotonicNs: order.requestMonotonicNs,
          responseMonotonicNs: order.responseMonotonicNs,
          httpStatus: order.httpStatus,
          schemaValid: false,
        });
      evidence = {
        parentExecutionKey: parent.executionKey,
        validationEventId: parent.validationEventId,
        policyVersion: this.policy.policyVersion,
        referenceTimestampMs: parent.referenceTimestampMs,
        intendedDelayMs,
        actualRequestTimestampMs: order.requestTimestampMs,
        actualResponseTimestampMs: order.responseTimestampMs,
        actualObservedDelayMs:
          order.requestTimestampMs - parent.referenceTimestampMs,
        requestMonotonicNs: order.requestMonotonicNs,
        responseMonotonicNs: order.responseMonotonicNs,
        inputMint: parent.inputMint,
        outputMint: parent.outputMint,
        inputAmountRaw: parent.inputAmountRaw,
        returnedInputAmountRaw: null,
        returnedInputAmountStatus: "UNAVAILABLE",
        returnedOutputAmountRaw: order.expectedOutputRaw,
        jupiterRequestId: order.requestId,
        swapMode: order.mode,
        httpStatus: order.httpStatus,
        schemaValid: true,
        router: order.router,
        route: order.route.length === 0 ? null : order.route,
        routeStatus: order.route.length === 0 ? "UNAVAILABLE" : "AVAILABLE",
        priceImpactPct: order.priceImpactPct ?? null,
        outcome: "SUCCESS",
        failureCode: null,
        failureDetail: null,
      };
    } catch (error) {
      const telemetry = requestTelemetry(error);
      const requestTimestampMs =
        telemetry?.requestTimestampMs ?? fallbackRequestTimestampMs;
      evidence = {
        parentExecutionKey: parent.executionKey,
        validationEventId: parent.validationEventId,
        policyVersion: this.policy.policyVersion,
        referenceTimestampMs: parent.referenceTimestampMs,
        intendedDelayMs,
        actualRequestTimestampMs: requestTimestampMs,
        actualResponseTimestampMs: telemetry?.responseTimestampMs ?? null,
        actualObservedDelayMs: requestTimestampMs - parent.referenceTimestampMs,
        requestMonotonicNs: telemetry?.requestMonotonicNs ?? null,
        responseMonotonicNs: telemetry?.responseMonotonicNs ?? null,
        inputMint: parent.inputMint,
        outputMint: parent.outputMint,
        inputAmountRaw: parent.inputAmountRaw,
        returnedInputAmountRaw: null,
        returnedInputAmountStatus: "UNAVAILABLE",
        returnedOutputAmountRaw: null,
        jupiterRequestId: null,
        swapMode: null,
        httpStatus: telemetry?.httpStatus ?? null,
        schemaValid: telemetry?.schemaValid ?? false,
        router: null,
        route: null,
        routeStatus: "UNAVAILABLE",
        priceImpactPct: null,
        outcome: "FAILURE",
        failureCode: failureCode(error),
        failureDetail: error instanceof Error ? error.message : String(error),
      };
    }
    await this.store.append(evidence);
  }
}
