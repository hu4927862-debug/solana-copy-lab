import type {
  StreamProvider,
  StreamSubscription,
  StreamTransactionEnvelope,
} from "../domain/ports.js";
import type { FaultInjectableSubscription } from "./stream-health.js";

export interface ProviderReceiptSink {
  enqueueProviderReceipt(
    provider: string,
    envelope: StreamTransactionEnvelope,
    isReplay?: boolean,
  ): void;
}

export interface DualStreamOptions {
  readonly primary: {
    readonly name: string;
    readonly provider: StreamProvider;
  };
  readonly secondary?: {
    readonly name: string;
    readonly provider: StreamProvider;
  };
  readonly receipts: ProviderReceiptSink;
}

/**
 * The passive provider has no path to the transaction handler by design. This
 * class is the single enforcement point preventing benchmark traffic from
 * entering copy execution.
 */
export class DualStreamCoordinator {
  private primarySubscription: StreamSubscription | undefined;
  private secondarySubscription: StreamSubscription | undefined;
  private closing = false;
  private starting: Promise<void> | undefined;

  constructor(private readonly options: DualStreamOptions) {}

  async start(
    wallets: readonly string[],
    onPrimaryTransaction: (envelope: StreamTransactionEnvelope) => unknown,
  ): Promise<void> {
    if (this.closing || this.starting)
      throw new Error("STREAM_START_UNAVAILABLE");
    this.starting = this.startSubscriptions(wallets, onPrimaryTransaction);
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startSubscriptions(
    wallets: readonly string[],
    onPrimaryTransaction: (envelope: StreamTransactionEnvelope) => unknown,
  ): Promise<void> {
    if (this.primarySubscription || this.secondarySubscription) {
      throw new Error("Dual stream coordinator already started");
    }
    const primary = await this.options.primary.provider.subscribe(
      wallets,
      (envelope) => {
        this.options.receipts.enqueueProviderReceipt(
          this.options.primary.name,
          envelope,
          envelope.deliveryType === "REPLAY",
        );
        return onPrimaryTransaction(envelope);
      },
    );
    if (this.closing) {
      await primary.close();
      return;
    }
    this.primarySubscription = primary;
    if (this.options.secondary) {
      this.secondarySubscription =
        await this.options.secondary.provider.subscribe(wallets, (envelope) => {
          this.options.receipts.enqueueProviderReceipt(
            this.options.secondary!.name,
            envelope,
            envelope.deliveryType === "REPLAY",
          );
        });
    }
  }

  async updateTargets(wallets: readonly string[]): Promise<void> {
    if (!this.primarySubscription)
      throw new Error("Dual stream coordinator is not started");
    await Promise.all([
      this.primarySubscription.updateTargets(wallets),
      this.secondarySubscription?.updateTargets(wallets),
    ]);
  }

  async injectPrimaryDisconnect(durationMs: number): Promise<void> {
    const subscription = this.primarySubscription as
      (StreamSubscription & Partial<FaultInjectableSubscription>) | undefined;
    if (!subscription?.injectDisconnect) {
      throw new Error("Primary provider does not support fault injection");
    }
    await subscription.injectDisconnect(durationMs);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.starting?.catch(() => undefined);
    const primary = this.primarySubscription;
    const secondary = this.secondarySubscription;
    this.primarySubscription = undefined;
    this.secondarySubscription = undefined;
    await Promise.all([primary?.close(), secondary?.close()]);
  }
}
