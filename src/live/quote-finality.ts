/** A quote has one clock, starting BEFORE its HTTP request. Finality polling is
 * successful state observation, never a retry of an unsuccessful request. */
export const FINALITY_SYNC_POLICY = { maxPollsPerQuote: 3, pollIntervalMs: 10000,
  maxWaitMs: 30000, maxQuoteAgeMs: 60000 } as const;
export interface FinalityReceipt {
  result: "READY" | "STOPPED";
  reason?: string;
  quoteContextSlot: number;
  quoteRequestedAtMs: number;
  quoteExpiresAtMs: number;
  startedAtMs: number;
  completedAtMs: number;
  polls: number;
  commitment?: "confirmed";
  probes: { requestId: number; finalizedSlot?: number; confirmedSlot?: number; observedAtMs: number }[];
  finalizedSlot?: number;
  confirmedSlot?: number;
  networkRetries: 0;
  policy: typeof FINALITY_SYNC_POLICY;
}
export class QuoteFinality {
  quoteRequestedAtMs: number | undefined;
  quoteExpiresAtMs: number | undefined;
  private finalityDeadlineMs: number | undefined;
  private operationDeadlineMs: number | undefined;
  receipt: FinalityReceipt | undefined;
  constructor(private readonly now: () => number = Date.now) {}
  prepare(deadline: number): void { this.finish(); this.receipt = undefined; this.operationDeadlineMs = deadline; }
  finish(): void { this.quoteRequestedAtMs = this.quoteExpiresAtMs = this.finalityDeadlineMs = this.operationDeadlineMs = undefined; }
  begin(): void {
    this.assertCurrent(); this.receipt = undefined;
    this.quoteRequestedAtMs = this.now();
    this.quoteExpiresAtMs = this.quoteRequestedAtMs + FINALITY_SYNC_POLICY.maxQuoteAgeMs;
  }
  synchronizing(): boolean { return this.finalityDeadlineMs !== undefined; }
  deadline(): number { return Math.min(this.quoteExpiresAtMs ?? Infinity,
    this.finalityDeadlineMs ?? Infinity, this.operationDeadlineMs ?? Infinity); }
  assertCurrent(): void {
    const now = this.now();
    if (now >= (this.operationDeadlineMs ?? Infinity)) throw Error("PREPARATION_DEADLINE_EXCEEDED");
    if (now >= (this.quoteExpiresAtMs ?? Infinity)) throw Error("PREFLIGHT_QUOTE_EXPIRED");
    if (now >= (this.finalityDeadlineMs ?? Infinity)) throw Error("PREFLIGHT_FINALITY_TIMEOUT");
  }
  signal(): AbortSignal | undefined {
    this.assertCurrent();
    return Number.isFinite(this.deadline()) ? AbortSignal.timeout(Math.max(1, Math.ceil(this.deadline() - this.now()))) : undefined;
  }
  async synchronize(context: unknown, read: () => Promise<{ slot: unknown; requestId: number }>,
    assertOuter: () => void, outerSignal: () => AbortSignal | undefined, commitment: "finalized" | "confirmed" = "finalized"): Promise<void> {
    if (typeof context !== "number" || !Number.isSafeInteger(context) || context <= 0)
      throw Error("PREFLIGHT_QUOTE_CONTEXT_INVALID");
    const startedAtMs = this.now(); this.finalityDeadlineMs = startedAtMs + FINALITY_SYNC_POLICY.maxWaitMs;
    const r: FinalityReceipt = { result: "STOPPED", quoteContextSlot: context,
      quoteRequestedAtMs: this.quoteRequestedAtMs!, quoteExpiresAtMs: this.quoteExpiresAtMs!,
      startedAtMs, completedAtMs: startedAtMs, polls: 0, probes: [], networkRetries: 0, policy: FINALITY_SYNC_POLICY,
      ...(commitment === "confirmed" ? {commitment} : {}) };
    try {
      while (r.polls < FINALITY_SYNC_POLICY.maxPollsPerQuote) {
        assertOuter(); this.assertCurrent(); r.polls++;
        const { slot, requestId } = await read(); assertOuter(); this.assertCurrent();
        if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0)
          throw Error("PREFLIGHT_FINALITY_CONTEXT_INVALID");
        r.probes.push({ requestId, ...(commitment === "confirmed" ? {confirmedSlot:slot} : {finalizedSlot:slot}), observedAtMs: this.now() });
        if(commitment === "confirmed") r.confirmedSlot = slot; else r.finalizedSlot = slot;
        if (slot >= context) { r.result = "READY"; return; }
        if (r.polls === FINALITY_SYNC_POLICY.maxPollsPerQuote) throw Error("PREFLIGHT_FINALITY_POLL_LIMIT");
        const signal = outerSignal();
        await new Promise<void>(done => {
          const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); done(); };
          const timer = setTimeout(finish,
            Math.min(FINALITY_SYNC_POLICY.pollIntervalMs, Math.max(0, this.deadline() - this.now())));
          if (signal?.aborted) finish(); else signal?.addEventListener("abort", finish, { once: true });
        });
      }
    } catch (e) {
      r.reason = e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : "FINALITY_REQUEST_FAILED";
      throw e;
    } finally { r.completedAtMs = this.now(); this.receipt = r; this.finalityDeadlineMs = undefined; }
  }
}
