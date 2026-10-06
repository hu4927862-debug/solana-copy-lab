import type { TradeSide } from "../domain/trades.js";
import type { PositionTransition } from "../domain/positions.js";

export const FOLLOWER_ROUND_TRIPS_DEFINITION_VERSION =
  "FOLLOWER_ROUND_TRIPS_V2" as const;

export interface FollowerFillApplicationEvidence {
  readonly fillId: string;
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly side: TradeSide;
  readonly transition: PositionTransition;
  readonly inputAmountRaw: bigint;
  readonly outputAmountRaw: bigint;
  readonly quantityBeforeRaw: bigint;
  readonly quantityAfterRaw: bigint;
  readonly allocatedCostBasisRaw: bigint;
  readonly proceedsRaw: bigint;
  readonly realizedPnlDeltaRaw: bigint;
  readonly positionVersionAfter: number;
  readonly quoteTimestampMs: number;
}

export interface DetailedFollowerFillApplicationEvidence extends FollowerFillApplicationEvidence {
  readonly positionId: number;
}

export interface FollowerRoundTripLifecycleIdentity {
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly tokenMint: string;
  readonly quoteMint: string;
}

export interface FollowerRoundTripLimitationFieldEvidence {
  readonly field: string;
  readonly expected: string;
  readonly observed: string;
}

export interface FollowerRoundTripUnevaluableLimitation {
  readonly kind: "LIFECYCLE_UNEVALUABLE";
  readonly scope: "APPLICATION" | "LIFECYCLE";
  readonly reason:
    | "APPLICATION_EVIDENCE_CONFLICT"
    | "COST_BASIS_OVER_ALLOCATED"
    | "CYCLE_PNL_INVARIANT_VIOLATION"
    | "ECONOMIC_EVIDENCE_INVALID"
    | "LIFECYCLE_CONTINUITY_VIOLATION"
    | "LIFECYCLE_IDENTITY_UNPROVEN"
    | "LIFECYCLE_TRANSITION_INVALID";
  readonly stage: "APPLICATION" | "OPEN" | "CONTINUATION" | "FINALIZATION";
  readonly lifecycleIdentity: FollowerRoundTripLifecycleIdentity;
  readonly openFillId: string | null;
  readonly affectedFillIds: readonly string[];
  readonly evidence: readonly FollowerRoundTripLimitationFieldEvidence[];
}

export interface FollowerRoundTripDetailedResult {
  readonly definitionVersion: typeof FOLLOWER_ROUND_TRIPS_DEFINITION_VERSION;
  readonly completed: readonly CompletedFollowerRoundTrip[];
  readonly incomplete: readonly IncompleteFollowerRoundTrip[];
  readonly limitations: readonly FollowerRoundTripUnevaluableLimitation[];
}

export interface CompletedFollowerRoundTrip {
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly openFillId: string;
  readonly closeFillId: string;
  readonly fillIds: readonly string[];
  readonly entryCostQuoteRaw: bigint;
  readonly proceedsQuoteRaw: bigint;
  readonly realizedPnlQuoteRaw: bigint;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly holdingTimeMs: number;
}

export interface IncompleteFollowerRoundTrip {
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly openFillId: string;
  readonly latestFillId: string;
  readonly fillIds: readonly string[];
  readonly remainingQuantityRaw: bigint;
}

interface ActiveFollowerLifecycle {
  readonly open: FollowerFillApplicationEvidence;
  readonly positionId: number | undefined;
  readonly fillIds: string[];
  entryCostQuoteRaw: bigint;
  allocatedCostBasisQuoteRaw: bigint;
  proceedsQuoteRaw: bigint;
  realizedPnlQuoteRaw: bigint;
  lastPositionVersionAfter: number;
  lastQuantityAfterRaw: bigint;
}

function positionIdentity(
  application: FollowerFillApplicationEvidence,
): string {
  return JSON.stringify([
    application.followerWallet,
    application.leaderWallet,
    application.tokenMint,
    application.quoteMint,
  ]);
}

function lifecycleIdentity(
  application: FollowerFillApplicationEvidence,
): FollowerRoundTripLifecycleIdentity {
  return {
    followerWallet: application.followerWallet,
    leaderWallet: application.leaderWallet,
    tokenMint: application.tokenMint,
    quoteMint: application.quoteMint,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareLimitations(
  left: FollowerRoundTripUnevaluableLimitation,
  right: FollowerRoundTripUnevaluableLimitation,
): number {
  for (const comparison of [
    compareText(
      left.lifecycleIdentity.followerWallet,
      right.lifecycleIdentity.followerWallet,
    ),
    compareText(
      left.lifecycleIdentity.leaderWallet,
      right.lifecycleIdentity.leaderWallet,
    ),
    compareText(
      left.lifecycleIdentity.tokenMint,
      right.lifecycleIdentity.tokenMint,
    ),
    compareText(
      left.lifecycleIdentity.quoteMint,
      right.lifecycleIdentity.quoteMint,
    ),
    compareText(left.openFillId ?? "", right.openFillId ?? ""),
    compareText(left.stage, right.stage),
    compareText(left.reason, right.reason),
    compareText(
      left.affectedFillIds.join("\u0000"),
      right.affectedFillIds.join("\u0000"),
    ),
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function copyLimitation(
  limitation: FollowerRoundTripUnevaluableLimitation,
): FollowerRoundTripUnevaluableLimitation {
  return {
    ...limitation,
    lifecycleIdentity: { ...limitation.lifecycleIdentity },
    affectedFillIds: [...limitation.affectedFillIds],
    evidence: limitation.evidence
      .map((item) => ({ ...item }))
      .sort(
        (left, right) =>
          compareText(left.field, right.field) ||
          compareText(left.expected, right.expected) ||
          compareText(left.observed, right.observed),
      ),
  };
}

function hasValidEvidenceIdentity(
  application: FollowerFillApplicationEvidence,
): boolean {
  return [
    application.fillId,
    application.followerWallet,
    application.leaderWallet,
    application.tokenMint,
    application.quoteMint,
  ].every((value) => value.length > 0);
}

function invalidEvidenceIdentityFields(
  application: FollowerFillApplicationEvidence,
): FollowerRoundTripLimitationFieldEvidence[] {
  return (
    [
      "fillId",
      "followerWallet",
      "leaderWallet",
      "tokenMint",
      "quoteMint",
    ] as const
  ).flatMap((field) =>
    application[field].length === 0
      ? [{ field, expected: "NON_EMPTY", observed: "" }]
      : [],
  );
}

function isStructurallyContinuousCandidate(
  application: FollowerFillApplicationEvidence,
  active: ActiveFollowerLifecycle,
): boolean {
  return (
    application.transition !== "OPEN" &&
    application.positionVersionAfter === active.lastPositionVersionAfter + 1 &&
    application.quantityBeforeRaw === active.lastQuantityAfterRaw
  );
}

function structurallyContinuousCandidateIdentities(
  application: FollowerFillApplicationEvidence,
  activeByPosition: Map<string, ActiveFollowerLifecycle>,
): string[] {
  const identities: string[] = [];
  for (const [identity, active] of activeByPosition) {
    if (isStructurallyContinuousCandidate(application, active)) {
      identities.push(identity);
    }
  }
  return identities;
}

function isSameApplicationEvidence(
  left: FollowerFillApplicationEvidence,
  right: FollowerFillApplicationEvidence,
): boolean {
  return (
    left.fillId === right.fillId &&
    left.followerWallet === right.followerWallet &&
    left.leaderWallet === right.leaderWallet &&
    left.tokenMint === right.tokenMint &&
    left.quoteMint === right.quoteMint &&
    left.side === right.side &&
    left.transition === right.transition &&
    left.inputAmountRaw === right.inputAmountRaw &&
    left.outputAmountRaw === right.outputAmountRaw &&
    left.quantityBeforeRaw === right.quantityBeforeRaw &&
    left.quantityAfterRaw === right.quantityAfterRaw &&
    left.allocatedCostBasisRaw === right.allocatedCostBasisRaw &&
    left.proceedsRaw === right.proceedsRaw &&
    left.realizedPnlDeltaRaw === right.realizedPnlDeltaRaw &&
    left.positionVersionAfter === right.positionVersionAfter &&
    left.quoteTimestampMs === right.quoteTimestampMs
  );
}

function conflictingApplicationFieldEvidence(
  left: FollowerFillApplicationEvidence,
  right: FollowerFillApplicationEvidence,
  leftPositionId: number | undefined,
  rightPositionId: number | undefined,
): FollowerRoundTripLimitationFieldEvidence[] {
  const fields = [
    "followerWallet",
    "leaderWallet",
    "tokenMint",
    "quoteMint",
    "side",
    "transition",
    "inputAmountRaw",
    "outputAmountRaw",
    "quantityBeforeRaw",
    "quantityAfterRaw",
    "allocatedCostBasisRaw",
    "proceedsRaw",
    "realizedPnlDeltaRaw",
    "positionVersionAfter",
    "quoteTimestampMs",
  ] as const;
  const evidence: FollowerRoundTripLimitationFieldEvidence[] = fields.flatMap(
    (field) =>
      left[field] === right[field]
        ? []
        : [
            {
              field,
              expected: String(left[field]),
              observed: String(right[field]),
            },
          ],
  );
  if (leftPositionId !== rightPositionId) {
    evidence.push({
      field: "positionId",
      expected: String(leftPositionId),
      observed: String(rightPositionId),
    });
  }
  return evidence;
}

function applicationEvidenceSortKey(
  application: FollowerFillApplicationEvidence,
  positionId: number | undefined,
): string {
  return JSON.stringify([
    application.followerWallet,
    application.leaderWallet,
    application.tokenMint,
    application.quoteMint,
    application.side,
    application.transition,
    application.inputAmountRaw.toString(),
    application.outputAmountRaw.toString(),
    application.quantityBeforeRaw.toString(),
    application.quantityAfterRaw.toString(),
    application.allocatedCostBasisRaw.toString(),
    application.proceedsRaw.toString(),
    application.realizedPnlDeltaRaw.toString(),
    application.positionVersionAfter,
    application.quoteTimestampMs,
    positionId,
  ]);
}

function provenanceScopeKey(
  application: FollowerFillApplicationEvidence,
  positionId: number | undefined,
): string {
  return JSON.stringify([
    positionId,
    application.followerWallet,
    application.leaderWallet,
    application.tokenMint,
    application.quoteMint,
  ]);
}

interface ConflictingFillProvenanceScope {
  readonly application: FollowerFillApplicationEvidence;
  readonly positionId: number | undefined;
}

type FollowerContinuationKind = "ADD" | "REDUCE" | "CLOSE";

function continuationKind(
  application: FollowerFillApplicationEvidence,
): FollowerContinuationKind | null {
  if (application.transition === "ADD" && application.side === "BUY") {
    return "ADD";
  }
  if (application.transition === "REDUCE" && application.side === "SELL") {
    return "REDUCE";
  }
  if (application.transition === "CLOSE" && application.side === "SELL") {
    return "CLOSE";
  }
  return null;
}

function recordFieldEvidence(
  evidence: FollowerRoundTripLimitationFieldEvidence[],
  field: string,
  expected: bigint | number | string | undefined,
  observed: bigint | number | string | undefined,
): void {
  evidence.push({
    field,
    expected: String(expected),
    observed: String(observed),
  });
}

function openEconomicEvidence(
  application: FollowerFillApplicationEvidence,
): FollowerRoundTripLimitationFieldEvidence[] {
  const evidence: FollowerRoundTripLimitationFieldEvidence[] = [];
  if (application.quantityBeforeRaw !== 0n) {
    recordFieldEvidence(
      evidence,
      "quantityBeforeRaw",
      0n,
      application.quantityBeforeRaw,
    );
  }
  if (application.quantityAfterRaw <= 0n) {
    recordFieldEvidence(
      evidence,
      "quantityAfterRaw",
      "> 0",
      application.quantityAfterRaw,
    );
  }
  if (application.inputAmountRaw <= 0n) {
    recordFieldEvidence(
      evidence,
      "inputAmountRaw",
      "> 0",
      application.inputAmountRaw,
    );
  }
  if (application.outputAmountRaw !== application.quantityAfterRaw) {
    recordFieldEvidence(
      evidence,
      "outputAmountRaw",
      application.quantityAfterRaw,
      application.outputAmountRaw,
    );
  }
  if (application.allocatedCostBasisRaw !== 0n) {
    recordFieldEvidence(
      evidence,
      "allocatedCostBasisRaw",
      0n,
      application.allocatedCostBasisRaw,
    );
  }
  if (application.proceedsRaw !== 0n) {
    recordFieldEvidence(evidence, "proceedsRaw", 0n, application.proceedsRaw);
  }
  if (application.realizedPnlDeltaRaw !== 0n) {
    recordFieldEvidence(
      evidence,
      "realizedPnlDeltaRaw",
      0n,
      application.realizedPnlDeltaRaw,
    );
  }
  return evidence;
}

function continuationEconomicEvidence(
  application: FollowerFillApplicationEvidence,
  kind: FollowerContinuationKind,
): FollowerRoundTripLimitationFieldEvidence[] {
  const evidence: FollowerRoundTripLimitationFieldEvidence[] = [];

  if (kind === "ADD") {
    if (application.quantityAfterRaw <= application.quantityBeforeRaw) {
      recordFieldEvidence(
        evidence,
        "quantityAfterRaw",
        `> ${application.quantityBeforeRaw}`,
        application.quantityAfterRaw,
      );
    }
    if (application.inputAmountRaw <= 0n) {
      recordFieldEvidence(
        evidence,
        "inputAmountRaw",
        "> 0",
        application.inputAmountRaw,
      );
    }
    const expectedOutput =
      application.quantityAfterRaw - application.quantityBeforeRaw;
    if (application.outputAmountRaw !== expectedOutput) {
      recordFieldEvidence(
        evidence,
        "outputAmountRaw",
        expectedOutput,
        application.outputAmountRaw,
      );
    }
    if (application.allocatedCostBasisRaw !== 0n) {
      recordFieldEvidence(
        evidence,
        "allocatedCostBasisRaw",
        0n,
        application.allocatedCostBasisRaw,
      );
    }
    if (application.proceedsRaw !== 0n) {
      recordFieldEvidence(evidence, "proceedsRaw", 0n, application.proceedsRaw);
    }
    if (application.realizedPnlDeltaRaw !== 0n) {
      recordFieldEvidence(
        evidence,
        "realizedPnlDeltaRaw",
        0n,
        application.realizedPnlDeltaRaw,
      );
    }
    return evidence;
  }

  if (kind === "REDUCE" || kind === "CLOSE") {
    if (
      kind === "REDUCE" &&
      (application.quantityAfterRaw <= 0n ||
        application.quantityAfterRaw >= application.quantityBeforeRaw)
    ) {
      recordFieldEvidence(
        evidence,
        "quantityAfterRaw",
        `> 0 and < ${application.quantityBeforeRaw}`,
        application.quantityAfterRaw,
      );
    }
    if (kind === "CLOSE" && application.quantityBeforeRaw <= 0n) {
      recordFieldEvidence(
        evidence,
        "quantityBeforeRaw",
        "> 0",
        application.quantityBeforeRaw,
      );
    }
    if (kind === "CLOSE" && application.quantityAfterRaw !== 0n) {
      recordFieldEvidence(
        evidence,
        "quantityAfterRaw",
        0n,
        application.quantityAfterRaw,
      );
    }
    const expectedInput =
      kind === "CLOSE"
        ? application.quantityBeforeRaw
        : application.quantityBeforeRaw - application.quantityAfterRaw;
    if (application.inputAmountRaw !== expectedInput) {
      recordFieldEvidence(
        evidence,
        "inputAmountRaw",
        expectedInput,
        application.inputAmountRaw,
      );
    }
    if (application.outputAmountRaw !== application.proceedsRaw) {
      recordFieldEvidence(
        evidence,
        "outputAmountRaw",
        application.proceedsRaw,
        application.outputAmountRaw,
      );
    }
    if (application.proceedsRaw < 0n) {
      recordFieldEvidence(
        evidence,
        "proceedsRaw",
        ">= 0",
        application.proceedsRaw,
      );
    }
    if (application.allocatedCostBasisRaw < 0n) {
      recordFieldEvidence(
        evidence,
        "allocatedCostBasisRaw",
        ">= 0",
        application.allocatedCostBasisRaw,
      );
    }
    const expectedPnl =
      application.proceedsRaw - application.allocatedCostBasisRaw;
    if (application.realizedPnlDeltaRaw !== expectedPnl) {
      recordFieldEvidence(
        evidence,
        "realizedPnlDeltaRaw",
        expectedPnl,
        application.realizedPnlDeltaRaw,
      );
    }
  }
  return evidence;
}

function replayFollowerRoundTrips(
  applications: readonly FollowerFillApplicationEvidence[],
  positionIdOf: (
    application: FollowerFillApplicationEvidence,
  ) => number | undefined,
  usePositionProvenance: boolean,
): FollowerRoundTripDetailedResult {
  const activeByPosition = new Map<string, ActiveFollowerLifecycle>();
  const activeIdentityByPositionId = new Map<number, string>();
  const completed: CompletedFollowerRoundTrip[] = [];
  const limitations: FollowerRoundTripUnevaluableLimitation[] = [];
  const seenFillIds = new Set<string>();
  const applicationsByFillId = new Map<
    string,
    FollowerFillApplicationEvidence[]
  >();
  const corruptPositionIdentities = new Set<string>();
  const corruptFillIds = new Set<string>();
  const conflictingProvenanceScopesByFillId = new Map<
    string,
    readonly ConflictingFillProvenanceScope[]
  >();

  const deleteActive = (
    identity: string,
  ): ActiveFollowerLifecycle | undefined => {
    const active = activeByPosition.get(identity);
    if (active === undefined) return undefined;
    activeByPosition.delete(identity);
    if (
      active.positionId !== undefined &&
      activeIdentityByPositionId.get(active.positionId) === identity
    ) {
      activeIdentityByPositionId.delete(active.positionId);
    }
    return active;
  };

  const invalidateIdentityMismatch = (
    identity: string,
    application: FollowerFillApplicationEvidence,
  ): boolean => {
    const active = deleteActive(identity);
    if (active === undefined) return false;
    const evidence: FollowerRoundTripLimitationFieldEvidence[] = (
      ["followerWallet", "leaderWallet", "tokenMint", "quoteMint"] as const
    ).flatMap((field) =>
      active.open[field] === application[field]
        ? []
        : [
            {
              field,
              expected: active.open[field],
              observed: application[field],
            },
          ],
    );
    const applicationPositionId = positionIdOf(application);
    if (active.positionId !== applicationPositionId) {
      evidence.push({
        field: "positionId",
        expected: String(active.positionId),
        observed: String(applicationPositionId),
      });
    }
    if (application.fillId.length === 0) {
      evidence.push({
        field: "fillId",
        expected: "NON_EMPTY",
        observed: "",
      });
    }
    limitations.push({
      kind: "LIFECYCLE_UNEVALUABLE",
      scope: "LIFECYCLE",
      reason: "LIFECYCLE_IDENTITY_UNPROVEN",
      stage: "CONTINUATION",
      lifecycleIdentity: lifecycleIdentity(active.open),
      openFillId: active.open.fillId,
      affectedFillIds: [active.open.fillId, application.fillId],
      evidence,
    });
    return true;
  };

  const invalidateUnmatchedContinuation = (
    application: FollowerFillApplicationEvidence,
  ): void => {
    const positionId = positionIdOf(application);
    const provenIdentity =
      positionId === undefined
        ? undefined
        : activeIdentityByPositionId.get(positionId);
    const candidateIdentities =
      provenIdentity === undefined
        ? positionId === undefined
          ? structurallyContinuousCandidateIdentities(
              application,
              activeByPosition,
            )
          : []
        : [provenIdentity];
    for (const candidateIdentity of candidateIdentities) {
      if (positionId === undefined) deleteActive(candidateIdentity);
      else invalidateIdentityMismatch(candidateIdentity, application);
    }
  };

  for (const application of applications) {
    const fillApplications = applicationsByFillId.get(application.fillId) ?? [];
    fillApplications.push(application);
    applicationsByFillId.set(application.fillId, fillApplications);
  }

  for (const [fillId, fillApplications] of applicationsByFillId) {
    const orderedApplications = fillApplications
      .map((application) => ({
        application,
        positionId: positionIdOf(application),
      }))
      .sort((left, right) =>
        compareText(
          applicationEvidenceSortKey(left.application, left.positionId),
          applicationEvidenceSortKey(right.application, right.positionId),
        ),
      );
    const first = orderedApplications[0]!;
    const isConflicting = orderedApplications.some(
      (candidate) =>
        !isSameApplicationEvidence(first.application, candidate.application) ||
        first.positionId !== candidate.positionId,
    );
    if (!isConflicting) continue;

    const scopesByKey = new Map<string, ConflictingFillProvenanceScope>();
    for (const candidate of orderedApplications) {
      const scopeKey = provenanceScopeKey(
        candidate.application,
        candidate.positionId,
      );
      if (!scopesByKey.has(scopeKey)) scopesByKey.set(scopeKey, candidate);
      if (!usePositionProvenance) {
        corruptPositionIdentities.add(positionIdentity(candidate.application));
      }
    }
    const scopes = [...scopesByKey.values()];
    corruptFillIds.add(fillId);
    conflictingProvenanceScopesByFillId.set(fillId, scopes);

    for (const scope of scopes) {
      const conflicting = orderedApplications.find(
        (candidate) =>
          !isSameApplicationEvidence(
            scope.application,
            candidate.application,
          ) || scope.positionId !== candidate.positionId,
      )!;
      limitations.push({
        kind: "LIFECYCLE_UNEVALUABLE",
        scope: "APPLICATION",
        reason: "APPLICATION_EVIDENCE_CONFLICT",
        stage: "APPLICATION",
        lifecycleIdentity: lifecycleIdentity(scope.application),
        openFillId: null,
        affectedFillIds: [fillId],
        evidence: conflictingApplicationFieldEvidence(
          scope.application,
          conflicting.application,
          scope.positionId,
          conflicting.positionId,
        ),
      });
    }
  }

  for (const application of applications) {
    if (usePositionProvenance && corruptFillIds.has(application.fillId)) {
      for (const scope of conflictingProvenanceScopesByFillId.get(
        application.fillId,
      ) ?? []) {
        const provenanceIdentity =
          scope.positionId === undefined
            ? undefined
            : activeIdentityByPositionId.get(scope.positionId);
        if (provenanceIdentity !== undefined) {
          deleteActive(provenanceIdentity);
          continue;
        }
        const identity = positionIdentity(scope.application);
        const canonicalActive = activeByPosition.get(identity);
        if (
          canonicalActive !== undefined &&
          (scope.positionId === undefined ||
            canonicalActive.positionId === scope.positionId)
        ) {
          deleteActive(identity);
        }
      }
      continue;
    }
    if (!hasValidEvidenceIdentity(application)) {
      const limitationCountBefore = limitations.length;
      invalidateUnmatchedContinuation(application);
      if (limitations.length === limitationCountBefore) {
        limitations.push({
          kind: "LIFECYCLE_UNEVALUABLE",
          scope: "APPLICATION",
          reason: "LIFECYCLE_IDENTITY_UNPROVEN",
          stage: "APPLICATION",
          lifecycleIdentity: lifecycleIdentity(application),
          openFillId: null,
          affectedFillIds: [application.fillId],
          evidence: invalidEvidenceIdentityFields(application),
        });
      }
      continue;
    }
    if (seenFillIds.has(application.fillId)) continue;
    seenFillIds.add(application.fillId);

    const identity = positionIdentity(application);
    if (corruptPositionIdentities.has(identity)) continue;

    const applicationPositionId = positionIdOf(application);
    if (
      application.transition !== "OPEN" &&
      applicationPositionId !== undefined
    ) {
      const provenanceIdentity = activeIdentityByPositionId.get(
        applicationPositionId,
      );
      if (provenanceIdentity !== undefined && provenanceIdentity !== identity) {
        invalidateIdentityMismatch(provenanceIdentity, application);
        continue;
      }
      const canonicalActive = activeByPosition.get(identity);
      if (
        provenanceIdentity === undefined &&
        canonicalActive?.positionId !== undefined &&
        canonicalActive.positionId !== applicationPositionId
      ) {
        invalidateIdentityMismatch(identity, application);
        continue;
      }
    }

    const permittedOpen =
      application.transition === "OPEN" && application.side === "BUY";
    const invalidOpenEvidence = permittedOpen
      ? openEconomicEvidence(application)
      : [];
    if (permittedOpen && invalidOpenEvidence.length === 0) {
      const positionId = positionIdOf(application);
      const provenanceIdentity =
        positionId === undefined
          ? undefined
          : activeIdentityByPositionId.get(positionId);
      if (provenanceIdentity !== undefined && provenanceIdentity !== identity) {
        invalidateIdentityMismatch(provenanceIdentity, application);
        continue;
      }
      const existingActive = activeByPosition.get(identity);
      if (existingActive !== undefined) {
        deleteActive(identity);
        limitations.push({
          kind: "LIFECYCLE_UNEVALUABLE",
          scope: "LIFECYCLE",
          reason: "LIFECYCLE_TRANSITION_INVALID",
          stage: "CONTINUATION",
          lifecycleIdentity: lifecycleIdentity(existingActive.open),
          openFillId: existingActive.open.fillId,
          affectedFillIds: [existingActive.open.fillId, application.fillId],
          evidence: [
            {
              field: "transitionSide",
              expected: "BUY:ADD|SELL:REDUCE|SELL:CLOSE",
              observed: "BUY:OPEN",
            },
          ],
        });
        continue;
      }
      activeByPosition.set(identity, {
        open: application,
        positionId,
        fillIds: [application.fillId],
        entryCostQuoteRaw: application.inputAmountRaw,
        allocatedCostBasisQuoteRaw: 0n,
        proceedsQuoteRaw: 0n,
        realizedPnlQuoteRaw: application.realizedPnlDeltaRaw,
        lastPositionVersionAfter: application.positionVersionAfter,
        lastQuantityAfterRaw: application.quantityAfterRaw,
      });
      if (positionId !== undefined) {
        activeIdentityByPositionId.set(positionId, identity);
      }
      continue;
    }

    const active = activeByPosition.get(identity);
    if (active === undefined) {
      if (permittedOpen) {
        limitations.push({
          kind: "LIFECYCLE_UNEVALUABLE",
          scope: "APPLICATION",
          reason: "ECONOMIC_EVIDENCE_INVALID",
          stage: "OPEN",
          lifecycleIdentity: lifecycleIdentity(application),
          openFillId: null,
          affectedFillIds: [application.fillId],
          evidence: invalidOpenEvidence,
        });
        continue;
      }
      invalidateUnmatchedContinuation(application);
      continue;
    }
    const hasMatchingPositionProvenance =
      active.positionId !== undefined &&
      applicationPositionId !== undefined &&
      active.positionId === applicationPositionId;
    // Position versions cover reservation/release mutations as well as fills.
    // With immutable position provenance, a strict increase plus the exact
    // quantity chain proves application order without inventing adjacency.
    // Evidence without position provenance retains the fail-closed +1 rule.
    const versionOrderIsProven = hasMatchingPositionProvenance
      ? application.positionVersionAfter > active.lastPositionVersionAfter
      : application.positionVersionAfter ===
        active.lastPositionVersionAfter + 1;
    if (!versionOrderIsProven) {
      deleteActive(identity);
      limitations.push({
        kind: "LIFECYCLE_UNEVALUABLE",
        scope: "LIFECYCLE",
        reason: "LIFECYCLE_CONTINUITY_VIOLATION",
        stage: "CONTINUATION",
        lifecycleIdentity: lifecycleIdentity(active.open),
        openFillId: active.open.fillId,
        affectedFillIds: [active.open.fillId, application.fillId],
        evidence: [
          {
            field: "positionVersionAfter",
            expected: hasMatchingPositionProvenance
              ? `>${active.lastPositionVersionAfter}`
              : String(active.lastPositionVersionAfter + 1),
            observed: String(application.positionVersionAfter),
          },
        ],
      });
      continue;
    }
    if (application.quantityBeforeRaw !== active.lastQuantityAfterRaw) {
      deleteActive(identity);
      limitations.push({
        kind: "LIFECYCLE_UNEVALUABLE",
        scope: "LIFECYCLE",
        reason: "LIFECYCLE_CONTINUITY_VIOLATION",
        stage: "CONTINUATION",
        lifecycleIdentity: lifecycleIdentity(active.open),
        openFillId: active.open.fillId,
        affectedFillIds: [active.open.fillId, application.fillId],
        evidence: [
          {
            field: "quantityBeforeRaw",
            expected: active.lastQuantityAfterRaw.toString(),
            observed: application.quantityBeforeRaw.toString(),
          },
        ],
      });
      continue;
    }
    const kind = continuationKind(application);
    const economicEvidence =
      kind === null ? [] : continuationEconomicEvidence(application, kind);
    const validContinuation = kind !== null && economicEvidence.length === 0;
    if (!validContinuation) {
      deleteActive(identity);
      if (kind !== null) {
        limitations.push({
          kind: "LIFECYCLE_UNEVALUABLE",
          scope: "LIFECYCLE",
          reason: "ECONOMIC_EVIDENCE_INVALID",
          stage: "CONTINUATION",
          lifecycleIdentity: lifecycleIdentity(active.open),
          openFillId: active.open.fillId,
          affectedFillIds: [active.open.fillId, application.fillId],
          evidence: economicEvidence,
        });
      } else {
        limitations.push({
          kind: "LIFECYCLE_UNEVALUABLE",
          scope: "LIFECYCLE",
          reason: "LIFECYCLE_TRANSITION_INVALID",
          stage: "CONTINUATION",
          lifecycleIdentity: lifecycleIdentity(active.open),
          openFillId: active.open.fillId,
          affectedFillIds: [active.open.fillId, application.fillId],
          evidence: [
            {
              field: "transitionSide",
              expected: "BUY:ADD|SELL:REDUCE|SELL:CLOSE",
              observed: `${application.side}:${application.transition}`,
            },
          ],
        });
      }
      continue;
    }
    if (
      (kind === "REDUCE" || kind === "CLOSE") &&
      active.allocatedCostBasisQuoteRaw + application.allocatedCostBasisRaw >
        active.entryCostQuoteRaw
    ) {
      deleteActive(identity);
      limitations.push({
        kind: "LIFECYCLE_UNEVALUABLE",
        scope: "LIFECYCLE",
        reason: "COST_BASIS_OVER_ALLOCATED",
        stage: "CONTINUATION",
        lifecycleIdentity: lifecycleIdentity(active.open),
        openFillId: active.open.fillId,
        affectedFillIds: [active.open.fillId, application.fillId],
        evidence: [
          {
            field: "cumulativeAllocatedCostBasisRaw",
            expected: active.entryCostQuoteRaw.toString(),
            observed: (
              active.allocatedCostBasisQuoteRaw +
              application.allocatedCostBasisRaw
            ).toString(),
          },
        ],
      });
      continue;
    }
    active.lastPositionVersionAfter = application.positionVersionAfter;
    active.lastQuantityAfterRaw = application.quantityAfterRaw;

    if (kind === "ADD") {
      active.fillIds.push(application.fillId);
      active.entryCostQuoteRaw += application.inputAmountRaw;
      active.realizedPnlQuoteRaw += application.realizedPnlDeltaRaw;
      continue;
    }

    if (kind === "REDUCE" || kind === "CLOSE") {
      active.fillIds.push(application.fillId);
      active.proceedsQuoteRaw += application.proceedsRaw;
      active.allocatedCostBasisQuoteRaw += application.allocatedCostBasisRaw;
      active.realizedPnlQuoteRaw += application.realizedPnlDeltaRaw;
    }

    if (kind !== "CLOSE" || application.quantityAfterRaw !== 0n) {
      continue;
    }
    if (
      active.realizedPnlQuoteRaw !==
      active.proceedsQuoteRaw - active.entryCostQuoteRaw
    ) {
      deleteActive(identity);
      limitations.push({
        kind: "LIFECYCLE_UNEVALUABLE",
        scope: "LIFECYCLE",
        reason: "CYCLE_PNL_INVARIANT_VIOLATION",
        stage: "FINALIZATION",
        lifecycleIdentity: lifecycleIdentity(active.open),
        openFillId: active.open.fillId,
        affectedFillIds: [...active.fillIds],
        evidence: [
          {
            field: "realizedPnlQuoteRaw",
            expected: (
              active.proceedsQuoteRaw - active.entryCostQuoteRaw
            ).toString(),
            observed: active.realizedPnlQuoteRaw.toString(),
          },
        ],
      });
      continue;
    }

    completed.push({
      followerWallet: active.open.followerWallet,
      leaderWallet: active.open.leaderWallet,
      tokenMint: active.open.tokenMint,
      quoteMint: active.open.quoteMint,
      openFillId: active.open.fillId,
      closeFillId: application.fillId,
      fillIds: active.fillIds,
      entryCostQuoteRaw: active.entryCostQuoteRaw,
      proceedsQuoteRaw: active.proceedsQuoteRaw,
      realizedPnlQuoteRaw: active.realizedPnlQuoteRaw,
      openedAtMs: active.open.quoteTimestampMs,
      closedAtMs: application.quoteTimestampMs,
      holdingTimeMs:
        application.quoteTimestampMs - active.open.quoteTimestampMs,
    });
    deleteActive(identity);
  }

  return {
    definitionVersion: FOLLOWER_ROUND_TRIPS_DEFINITION_VERSION,
    completed: completed.map((cycle) => ({
      ...cycle,
      fillIds: [...cycle.fillIds],
    })),
    incomplete: [...activeByPosition.values()].map((active) => ({
      followerWallet: active.open.followerWallet,
      leaderWallet: active.open.leaderWallet,
      tokenMint: active.open.tokenMint,
      quoteMint: active.open.quoteMint,
      openFillId: active.open.fillId,
      latestFillId: active.fillIds.at(-1)!,
      fillIds: [...active.fillIds],
      remainingQuantityRaw: active.lastQuantityAfterRaw,
    })),
    limitations: limitations.map(copyLimitation).sort(compareLimitations),
  };
}

export function matchFollowerRoundTripsDetailed(
  applications: readonly DetailedFollowerFillApplicationEvidence[],
): FollowerRoundTripDetailedResult {
  return replayFollowerRoundTrips(
    applications,
    (application) =>
      (application as DetailedFollowerFillApplicationEvidence).positionId,
    true,
  );
}

export function matchFollowerRoundTrips(
  applications: readonly FollowerFillApplicationEvidence[],
): {
  readonly completed: readonly CompletedFollowerRoundTrip[];
  readonly incomplete: readonly IncompleteFollowerRoundTrip[];
} {
  const { completed, incomplete } = replayFollowerRoundTrips(
    applications,
    () => undefined,
    false,
  );
  return { completed, incomplete };
}
