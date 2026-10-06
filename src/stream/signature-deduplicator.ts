export class SignatureDeduplicator {
  private readonly signatures = new Map<string, true>();

  constructor(private readonly capacity = 20_000) {}

  has(signature: string): boolean {
    return this.signatures.has(signature);
  }

  forget(signature: string): void {
    this.signatures.delete(signature);
  }

  accept(signature: string): boolean {
    if (this.signatures.has(signature)) return false;
    this.signatures.set(signature, true);
    if (this.signatures.size > this.capacity) {
      const oldest = this.signatures.keys().next().value as string | undefined;
      if (oldest !== undefined) this.signatures.delete(oldest);
    }
    return true;
  }
}
