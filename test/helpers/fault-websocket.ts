import type { WebSocketClient } from "../../src/stream/solana-websocket-stream-provider.js";

/** In-process wire fault source: actual provider parses JSON-RPC frames. No sockets. */
export class FaultWebSocket implements WebSocketClient {
  readyState = 0;
  private listeners = new Map<string, ((event: any) => void)[]>();
  private subscription = 0;
  constructor(open = true) {
    if (open) queueMicrotask(() => this.open());
  }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  send(data: string) {
    const request = JSON.parse(data);
    queueMicrotask(() =>
      this.message({
        jsonrpc: "2.0",
        id: request.id,
        result: ++this.subscription,
      }),
    );
  }
  message(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) });
  }
  notification(signature: string, slot: number) {
    this.message({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 1,
        result: {
          context: { slot },
          value: { signature, err: null, logs: [] },
        },
      },
    });
  }
  close(code = 1006, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }
}
