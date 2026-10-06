export type StreamHealthEventType =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTED"
  | "DEGRADED"
  | "REPLAY_STARTED"
  | "REPLAY_COMPLETED"
  | "REPLAY_FAILED";

export interface StreamHealthNotification {
  readonly provider: string;
  readonly type: StreamHealthEventType;
  readonly wallTimestampMs: number;
  readonly monotonicTimestampNs: bigint;
  readonly durationMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface StreamHealthObserver {
  notify(event: StreamHealthNotification): void;
}

export interface FaultInjectableSubscription {
  injectDisconnect(durationMs: number): Promise<void>;
}
