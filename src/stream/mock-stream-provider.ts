import type {
  StreamProvider,
  StreamSubscription,
  StreamTransactionEnvelope,
} from "../domain/ports.js";

export class MockStreamProvider implements StreamProvider {
  private targets = new Set<string>();
  private handler: ((envelope: StreamTransactionEnvelope) => void) | undefined;

  async subscribe(
    wallets: readonly string[],
    onTransaction: (envelope: StreamTransactionEnvelope) => void,
  ): Promise<StreamSubscription> {
    this.targets = new Set(wallets);
    this.handler = onTransaction;
    return {
      updateTargets: async (next) => {
        this.targets = new Set(next);
      },
      close: async () => {
        this.handler = undefined;
      },
    };
  }

  emit(
    envelope: StreamTransactionEnvelope,
    mentionedWallets: readonly string[],
  ): void {
    if (mentionedWallets.some((wallet) => this.targets.has(wallet)))
      this.handler?.(envelope);
  }
}
