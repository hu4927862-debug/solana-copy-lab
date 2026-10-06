export type PositionTransition = "OPEN" | "ADD" | "REDUCE" | "CLOSE";

export interface Position {
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly tokenMint: string;
  readonly quoteMint?: string;
  readonly rawAmount: bigint;
  readonly reservedRawAmount: bigint;
  readonly accountingPolicyVersion?: "WEIGHTED_AVERAGE_V1";
  readonly version: number;
  readonly state: "OPEN" | "CLOSED";
}

export interface PositionChange {
  readonly transition: PositionTransition;
  readonly beforeRaw: bigint;
  readonly afterRaw: bigint;
  readonly deltaRaw: bigint;
}

export function applyPositionDelta(
  currentRaw: bigint,
  signedDeltaRaw: bigint,
): PositionChange {
  if (currentRaw < 0n) throw new Error("Position cannot be negative");
  const requested = currentRaw + signedDeltaRaw;
  const afterRaw = requested < 0n ? 0n : requested;
  const actualDelta = afterRaw - currentRaw;
  let transition: PositionTransition;
  if (currentRaw === 0n && afterRaw > 0n) transition = "OPEN";
  else if (actualDelta > 0n) transition = "ADD";
  else if (afterRaw === 0n && currentRaw > 0n) transition = "CLOSE";
  else transition = "REDUCE";
  return { transition, beforeRaw: currentRaw, afterRaw, deltaRaw: actualDelta };
}
