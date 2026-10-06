import type {
  HistoricalIncludedLifecycleSourceTimingEvidence,
  VersionedHistoricalEvaluationResult,
} from "./historical-evaluation.js";
import type { LeaderTemporalCoverageBlock } from "./leader-temporal-coverage-diagnostics.js";
import type { CompletedFollowerRoundTrip } from "./round-trips.js";

export interface IncludedLifecycleTimingAssociation {
  readonly roundTrip: CompletedFollowerRoundTrip;
  readonly timing: HistoricalIncludedLifecycleSourceTimingEvidence;
}

function lifecycleKey(openFillId: string, closeFillId: string): string {
  return JSON.stringify([openFillId, closeFillId]);
}

export function associateIncludedRoundTripsWithTiming(
  historical: VersionedHistoricalEvaluationResult,
): readonly IncludedLifecycleTimingAssociation[] | null {
  if (
    historical.includedRoundTrips.length !==
    historical.includedLifecycleSourceTimingEvidence.length
  ) {
    return null;
  }

  const timingByLifecycle = new Map<
    string,
    HistoricalIncludedLifecycleSourceTimingEvidence
  >();
  for (const timing of historical.includedLifecycleSourceTimingEvidence) {
    const key = lifecycleKey(timing.openFillId, timing.closeFillId);
    if (timingByLifecycle.has(key)) return null;
    timingByLifecycle.set(key, timing);
  }

  const seenRoundTrips = new Set<string>();
  const associations: IncludedLifecycleTimingAssociation[] = [];
  for (const roundTrip of historical.includedRoundTrips) {
    const key = lifecycleKey(roundTrip.openFillId, roundTrip.closeFillId);
    if (seenRoundTrips.has(key)) return null;
    seenRoundTrips.add(key);
    const timing = timingByLifecycle.get(key);
    if (
      timing === undefined ||
      timing.followerWallet !== roundTrip.followerWallet ||
      timing.leaderWallet !== roundTrip.leaderWallet ||
      timing.tokenMint !== roundTrip.tokenMint ||
      timing.quoteMint !== roundTrip.quoteMint
    ) {
      return null;
    }
    associations.push({ roundTrip, timing });
  }

  return seenRoundTrips.size === timingByLifecycle.size ? associations : null;
}

export function findAlignedTemporalBlock(
  blocks: readonly LeaderTemporalCoverageBlock[],
  authoritativeOpenSourceTimestampMs: number,
): LeaderTemporalCoverageBlock | undefined {
  return blocks.find(
    ({ blockStartMs, blockEndMs }) =>
      authoritativeOpenSourceTimestampMs >= blockStartMs &&
      authoritativeOpenSourceTimestampMs < blockEndMs,
  );
}
