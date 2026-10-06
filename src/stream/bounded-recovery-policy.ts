export interface BoundedRecoveryPolicy {
  readonly version: "BOUNDED_REPLAY_V1";
  readonly maxEpisodeMs: number;
  readonly maxAttempts: number;
  readonly maxBuffered: number;
}

/** Transport recovery budgets, never trade authorization or Risk thresholds. */
export function boundedRecoveryPolicy(
  value?: string,
): BoundedRecoveryPolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== "BOUNDED_REPLAY_V1")
    throw new Error("INVALID_STREAM_RECOVERY_POLICY");
  return {
    version: value,
    maxEpisodeMs: 90_000,
    maxAttempts: 3,
    maxBuffered: 10_000,
  };
}
