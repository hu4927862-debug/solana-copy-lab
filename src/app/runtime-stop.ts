import type { EventEmitter } from "node:events";

/** Installed before any awaited startup work. First stop wins; deadline never moves. */
export class RuntimeStopController {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  private reason: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private deadlineSet = false;
  private resolve!: (reason: string) => void;
  private readonly completed = new Promise<string>((resolve) => {
    this.resolve = resolve;
  });
  private readonly sigterm = () => this.request("SIGTERM");
  private readonly sigint = () => this.request("SIGINT");
  constructor(
    private readonly signals: Pick<
      EventEmitter,
      "on" | "removeListener"
    > = process,
  ) {
    signals.on("SIGTERM", this.sigterm);
    signals.on("SIGINT", this.sigint);
  }
  setDeadline(deadlineMs: number): void {
    if (this.deadlineSet || !Number.isSafeInteger(deadlineMs))
      throw new Error("RUNTIME_DEADLINE_INVALID");
    this.deadlineSet = true;
    if (this.reason) return;
    this.timer = setTimeout(
      () => this.request("DURATION_COMPLETE"),
      Math.max(0, deadlineMs - Date.now()),
    );
  }
  request(reason: string): void {
    if (this.reason) return;
    this.reason = reason;
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort(new Error("RUNTIME_STOP_REQUESTED"));
    this.resolve(reason);
  }
  wait(): Promise<string> {
    return this.completed;
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.signals.removeListener("SIGTERM", this.sigterm);
    this.signals.removeListener("SIGINT", this.sigint);
  }
}
