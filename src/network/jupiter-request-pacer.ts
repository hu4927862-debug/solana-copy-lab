export const JUPITER_FREE_PACING_VERSION = "JUPITER_FREE_2S_V1";

export class JupiterPacingRejectedError extends Error {
  constructor() {
    super("JUPITER_LOCAL_RATE_LIMIT");
    this.name = "JupiterPacingRejectedError";
  }
}

/** Fail-fast admission, no queue and no new authorization lifetime. Keep the
 * entire transport/body lifetime exclusive, then wait two seconds before the
 * next admission. DNS latency therefore cannot compress two HTTP starts. */
export class JupiterRequestPacer {
  private busy = false;
  private nextAt: number;
  constructor(private readonly now: () => number = () => performance.now()) {
    this.nextAt = now() + 2_000; // startup quiet period; no restart burst credit
  }
  acquire(): () => void {
    if (this.busy || this.now() < this.nextAt)
      throw new JupiterPacingRejectedError();
    this.busy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.nextAt = this.now() + 2_000;
      this.busy = false;
    };
  }
}

let accountPacer: JupiterRequestPacer | undefined;
export function configuredJupiterPacer(): JupiterRequestPacer | undefined {
  const version = process.env.V6_JUPITER_ACCOUNT_PACING;
  if (version === undefined) return undefined; // legacy experiment semantics
  if (version !== JUPITER_FREE_PACING_VERSION)
    throw Error("UNKNOWN_JUPITER_ACCOUNT_PACING");
  return (accountPacer ??= new JupiterRequestPacer());
}
