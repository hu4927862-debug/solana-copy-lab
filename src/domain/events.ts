import type { ClockReading } from "./time.js";

export interface ExecutionEvent {
  readonly executionKey: string;
  readonly sequence: number;
  readonly type: string;
  readonly status: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly timestamp: ClockReading;
}

export interface SystemEvent {
  readonly type: string;
  readonly severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
  readonly component: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly timestamp: ClockReading;
}
