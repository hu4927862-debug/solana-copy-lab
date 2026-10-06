import { describe, expect, it } from "vitest";
import {
  classifyOpportunityFailure,
  isTerminalOpportunityFailure,
  projectPostQuoteFreshnessOutcome,
  type FailureClassification,
  type FailureTaxonomyPolicy,
  type NormalizedOpportunityEvidence,
} from "../../src/strategy-evaluation/failure-taxonomy.js";

const policy: FailureTaxonomyPolicy = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
};

const preTerminalRiskCases = [
  ["REJECT", "SINGLE_TRADE_LIMIT"],
  ["REJECT", "RISK_POLICY_FOR_QUOTE_UNAVAILABLE"],
  ["HALT", "GLOBAL_HALT_NEW_RISK"],
  ["REJECT", "INTENT_TIMESTAMP_UNAVAILABLE"],
  ["REJECT", "INTENT_TIMESTAMP_PROVENANCE_INVALID"],
  ["REJECT", "STALE_INTENT"],
  ["REJECT", "TOKEN_COST_EXPOSURE_LIMIT"],
  ["REJECT", "PORTFOLIO_COST_EXPOSURE_LIMIT"],
  ["HALT", "DAILY_REALIZED_LOSS_LIMIT"],
  ["REJECT", "PROVIDER_DEGRADED"],
  ["REJECT", "SELL_NOT_RISK_REDUCING"],
] as const;

function opportunity(
  overrides: Partial<NormalizedOpportunityEvidence> = {},
): NormalizedOpportunityEvidence {
  return {
    executionKey: "exec-1",
    ...overrides,
  };
}

describe("classifyOpportunityFailure", () => {
  it("classifies a Jupiter HTTP 429 as an execution failure", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 429,
              schemaValid: false,
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_HTTP_429",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies a Jupiter HTTP 5xx as an execution failure", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 503,
              schemaValid: false,
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_HTTP_5XX",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies another Jupiter non-2xx status without interpreting its body", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 400,
              schemaValid: false,
            },
          ],
          unstructuredFailureReasons: [
            "No route found for an allegedly invalid mint",
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_HTTP_400",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies a structured Jupiter attempt without an HTTP status broadly", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: null,
              schemaValid: false,
            },
          ],
          unstructuredFailureReasons: ["request timed out"],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_NO_HTTP_STATUS",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies an invalid Jupiter schema only after an HTTP 2xx", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: false,
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_SCHEMA_INVALID",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("does not classify a structurally successful Jupiter result as a failure", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER" }],
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "JUPITER_ORDER",
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("continues past a successful Jupiter result to a later POST rejection", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER" }],
            },
          ],
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "ROUTE_INVALID",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "MARKET_FAILURE",
      stage: "POST_QUOTE_RISK",
      reasonCode: "ROUTE_INVALID",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("keeps a 2xx schema-valid attempt without output and route evidence unavailable", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: null,
              route: [],
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when incomplete Jupiter success evidence has a POST decision", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: null,
              route: [],
            },
          ],
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "ROUTE_INVALID",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it.each(["request timeout", "Failed to get quotes"])(
    "does not infer a structured classification from free text: %s",
    (failureReason) => {
      expect(
        classifyOpportunityFailure(
          opportunity({ unstructuredFailureReasons: [failureReason] }),
          policy,
        ),
      ).toEqual({
        classificationStatus: "UNAVAILABLE",
        primaryCategory: null,
        stage: null,
        reasonCode: null,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      });
    },
  );

  it("classifies POST ROUTE_INVALID as a market failure", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "ROUTE_INVALID",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "MARKET_FAILURE",
      stage: "POST_QUOTE_RISK",
      reasonCode: "ROUTE_INVALID",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies POST PRICE_IMPACT_TOO_HIGH as a market failure", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "PRICE_IMPACT_TOO_HIGH",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "MARKET_FAILURE",
      stage: "POST_QUOTE_RISK",
      reasonCode: "PRICE_IMPACT_TOO_HIGH",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies POST PRICE_IMPACT_UNAVAILABLE as a data limitation", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "PRICE_IMPACT_UNAVAILABLE",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "DATA_LIMITATION",
      stage: "POST_QUOTE_RISK",
      reasonCode: "PRICE_IMPACT_UNAVAILABLE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies POST QUOTE_AMOUNT_MISMATCH as a data limitation", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "QUOTE_AMOUNT_MISMATCH",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "DATA_LIMITATION",
      stage: "POST_QUOTE_RISK",
      reasonCode: "QUOTE_AMOUNT_MISMATCH",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies a PRE PROVIDER_DEGRADED rejection as a risk rejection", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "REJECT",
              reasonCode: "PROVIDER_DEGRADED",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "RISK_REJECTION",
      stage: "PRE_QUOTE_RISK",
      reasonCode: "PROVIDER_DEGRADED",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it.each(preTerminalRiskCases)(
    "characterizes PRE %s %s as a risk rejection",
    (decision, reasonCode) => {
      expect(
        classifyOpportunityFailure(
          opportunity({
            riskDecisions: [
              {
                intentId: "exec-1",
                phase: "PRE_QUOTE",
                decision,
                reasonCode,
              },
            ],
          }),
          policy,
        ),
      ).toEqual({
        classificationStatus: "CLASSIFIED",
        primaryCategory: "RISK_REJECTION",
        stage: "PRE_QUOTE_RISK",
        reasonCode,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      });
    },
  );

  it("treats a PRE exposure resize without terminal evidence as not a failure", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "RESIZE",
              reasonCode: "PORTFOLIO_COST_EXPOSURE_LIMIT",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "PRE_QUOTE_RISK",
      reasonCode: "PORTFOLIO_COST_EXPOSURE_LIMIT",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies POST RISK_POLICY_FOR_QUOTE_UNAVAILABLE as a risk rejection", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "RISK_POLICY_FOR_QUOTE_UNAVAILABLE",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "RISK_REJECTION",
      stage: "POST_QUOTE_RISK",
      reasonCode: "RISK_POLICY_FOR_QUOTE_UNAVAILABLE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("keeps a POST-only reason used in PRE unavailable", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "REJECT",
              reasonCode: "ROUTE_INVALID",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("does not let Jupiter success mask an impossible POST Risk reason", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER" }],
            },
          ],
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "SINGLE_TRADE_LIMIT",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("keeps an impossible PRE resize reason unavailable", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "RESIZE",
              reasonCode: "PROVIDER_DEGRADED",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("does not classify a PRE exposure resize followed by an applied fill as a failure", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          followerTrade: {
            executionKey: "exec-1",
            state: "CONFIRMED",
          },
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "RESIZE",
              reasonCode: "TOKEN_COST_EXPOSURE_LIMIT",
            },
          ],
          paperFill: {
            id: "fill-1",
            intentId: "exec-1",
          },
          paperFillApplication: { fillId: "fill-1" },
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "PAPER_APPLICATION",
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("leaves a FAILED follower state without structured reason evidence unavailable", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          followerTrade: {
            executionKey: "exec-1",
            state: "FAILED",
          },
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("does not let an upstream Jupiter success mask a reasonless FAILED follower", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          followerTrade: {
            executionKey: "exec-1",
            state: "FAILED",
          },
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER" }],
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("does not let a PRE resize mask a reasonless FAILED follower", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          followerTrade: {
            executionKey: "exec-1",
            state: "FAILED",
          },
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "RESIZE",
              reasonCode: "TOKEN_COST_EXPOSURE_LIMIT",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it.each([
    "SIZE_ROUNDED_TO_ZERO",
    "NO_MAPPED_POSITION",
    "INSUFFICIENT_MAPPED_POSITION",
  ] as const)(
    "classifies exact follower copy reason %s as a copyability failure",
    (structuredReasonCode) => {
      expect(
        classifyOpportunityFailure(
          opportunity({
            followerTrade: {
              executionKey: "exec-1",
              state: "SKIPPED",
              structuredReasonCode,
            },
          }),
          policy,
        ),
      ).toEqual({
        classificationStatus: "CLASSIFIED",
        primaryCategory: "COPYABILITY_FAILURE",
        stage: "COPY_DECISION",
        reasonCode: structuredReasonCode,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      });
    },
  );

  it("classifies POST STALE_QUOTE as a copyability failure", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "STALE_QUOTE",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "COPYABILITY_FAILURE",
      stage: "POST_QUOTE_RISK",
      reasonCode: "STALE_QUOTE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it.each([
    "LEADER_PRE_BALANCE_ZERO",
    "LEADER_SELL_EXCEEDS_PRE_BALANCE",
    "LEGACY_POSITION_COST_BASIS_UNAVAILABLE",
    "POSITION_QUOTE_MISMATCH",
  ] as const)(
    "classifies exact follower evidence issue %s as a data limitation",
    (structuredReasonCode) => {
      expect(
        classifyOpportunityFailure(
          opportunity({
            followerTrade: {
              executionKey: "exec-1",
              state: "SKIPPED",
              structuredReasonCode,
            },
          }),
          policy,
        ),
      ).toEqual({
        classificationStatus: "CLASSIFIED",
        primaryCategory: "DATA_LIMITATION",
        stage: "COPY_DECISION",
        reasonCode: structuredReasonCode,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      });
    },
  );

  it.each([
    "PARSER_FAILURE",
    "AMBIGUOUS_OWNERSHIP",
    "NO_ASSET_DELTA",
    "UNKNOWN_SWAP_PROGRAM",
    "NO_SWAP_EVIDENCE",
    "NO_QUOTE_ASSET",
    "TOKEN_TO_TOKEN",
    "MISSING_DECIMALS",
    "UNSUPPORTED_TOKEN_2022",
    "AMBIGUOUS_DIRECTION",
  ] as const)(
    "classifies exact observation evidence issue %s as a data limitation",
    (observationReasonCode) => {
      expect(
        classifyOpportunityFailure(
          opportunity({ observationReasonCode }),
          policy,
        ),
      ).toEqual({
        classificationStatus: "CLASSIFIED",
        primaryCategory: "DATA_LIMITATION",
        stage: "OBSERVATION_CLASSIFICATION",
        reasonCode: observationReasonCode,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      });
    },
  );

  it.each(["TRANSACTION_FAILED", "LEADER_NOT_SIGNER"])(
    "keeps unsupported structured observation reason %s unavailable",
    (observationReasonCode) => {
      expect(
        classifyOpportunityFailure(
          opportunity({ observationReasonCode }),
          policy,
        ),
      ).toEqual({
        classificationStatus: "UNAVAILABLE",
        primaryCategory: null,
        stage: null,
        reasonCode: null,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      });
    },
  );

  it("does not let Jupiter success mask an unsupported observation rejection", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          observationReasonCode: "TRANSACTION_FAILED",
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER" }],
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies the formal UNSUPPORTED observation classification as a data limitation", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({ observationClassification: "UNSUPPORTED" }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "DATA_LIMITATION",
      stage: "OBSERVATION_CLASSIFICATION",
      reasonCode: "UNSUPPORTED",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("keeps an application without a projected matching fill unavailable", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          paperFillApplication: { fillId: "orphan-fill" },
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("does not let Jupiter success mask an unprojected orphan application", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER" }],
            },
          ],
          paperFillApplication: { fillId: "orphan-fill" },
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("classifies QUOTE_ASSET_NOT_ALLOWED as a policy exclusion", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          policyExclusionReasonCode: "QUOTE_ASSET_NOT_ALLOWED",
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "POLICY_EXCLUSION",
      stage: "OBSERVATION_POLICY",
      reasonCode: "QUOTE_ASSET_NOT_ALLOWED",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it.each([
    "ORDINARY_TRANSFER",
    "LIQUIDITY_OPERATION",
    "STAKE_OR_LENDING",
  ] as const)(
    "treats exact non-swap observation reason %s as not a failure",
    (observationReasonCode) => {
      expect(
        classifyOpportunityFailure(
          opportunity({ observationReasonCode }),
          policy,
        ),
      ).toEqual({
        classificationStatus: "NOT_A_FAILURE",
        primaryCategory: null,
        stage: "OBSERVATION_CLASSIFICATION",
        reasonCode: observationReasonCode,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      });
    },
  );

  it.each(["TRANSFER", "LP", "STAKE", "LENDING"] as const)(
    "treats formal non-swap classification %s as not a failure",
    (observationClassification) => {
      expect(
        classifyOpportunityFailure(
          opportunity({ observationClassification }),
          policy,
        ),
      ).toEqual({
        classificationStatus: "NOT_A_FAILURE",
        primaryCategory: null,
        stage: "OBSERVATION_CLASSIFICATION",
        reasonCode: observationClassification,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      });
    },
  );

  it("fails closed when the same opportunity has conflicting Jupiter evidence", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 429,
              schemaValid: false,
            },
            {
              executionKey: "exec-1",
              httpStatus: 503,
              schemaValid: false,
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when one Jupiter identity has conflicting success completeness", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER" }],
            },
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: null,
              route: [],
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when one Jupiter identity has different non-empty routes", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER", percent: 100 }],
            },
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "RAYDIUM", percent: 100 }],
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when Jupiter evidence belongs to another opportunity identity", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-other",
              httpStatus: 429,
              schemaValid: false,
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when Risk evidence belongs to another intent identity", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-other",
              phase: "PRE_QUOTE",
              decision: "REJECT",
              reasonCode: "PROVIDER_DEGRADED",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when follower evidence belongs to another execution identity", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          followerTrade: {
            executionKey: "exec-other",
            state: "SKIPPED",
            structuredReasonCode: "SIZE_ROUNDED_TO_ZERO",
          },
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when PaperFill belongs to another intent identity", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          paperFill: {
            id: "fill-1",
            intentId: "exec-other",
          },
          paperFillApplication: { fillId: "fill-1" },
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when PaperFill and application identities disagree", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          paperFill: {
            id: "fill-1",
            intentId: "exec-1",
          },
          paperFillApplication: { fillId: "fill-other" },
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("deduplicates consistent Jupiter evidence for one execution identity", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 429,
              schemaValid: false,
            },
            {
              executionKey: "exec-1",
              httpStatus: 429,
              schemaValid: false,
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_HTTP_429",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("deduplicates consistent Risk evidence for one phase and intent identity", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "REJECT",
              reasonCode: "PROVIDER_DEGRADED",
            },
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "REJECT",
              reasonCode: "PROVIDER_DEGRADED",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "RISK_REJECTION",
      stage: "PRE_QUOTE_RISK",
      reasonCode: "PROVIDER_DEGRADED",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when a PRE rejection has later Jupiter evidence", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "REJECT",
              reasonCode: "PROVIDER_DEGRADED",
            },
          ],
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when a terminal Jupiter failure has a POST decision", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 503,
              schemaValid: false,
            },
          ],
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "ROUTE_INVALID",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when a terminal POST rejection has an applied PaperFill", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "POST_QUOTE",
              decision: "REJECT",
              reasonCode: "ROUTE_INVALID",
            },
          ],
          paperFill: {
            id: "fill-1",
            intentId: "exec-1",
          },
          paperFillApplication: { fillId: "fill-1" },
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when the same risk phase has conflicting evidence", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          riskDecisions: [
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "REJECT",
              reasonCode: "PROVIDER_DEGRADED",
            },
            {
              intentId: "exec-1",
              phase: "PRE_QUOTE",
              decision: "ALLOW",
              reasonCode: "ALLOW",
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when a FAILED follower state has an applied PaperFill", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          followerTrade: {
            executionKey: "exec-1",
            state: "FAILED",
          },
          paperFill: {
            id: "fill-1",
            intentId: "exec-1",
          },
          paperFillApplication: { fillId: "fill-1" },
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when a policy exclusion has later execution evidence", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          policyExclusionReasonCode: "QUOTE_ASSET_NOT_ALLOWED",
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when policy exclusion conflicts with parser evidence", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          policyExclusionReasonCode: "QUOTE_ASSET_NOT_ALLOWED",
          observationReasonCode: "PARSER_FAILURE",
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("does not let policy exclusion mask an unknown observation rejection", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          policyExclusionReasonCode: "QUOTE_ASSET_NOT_ALLOWED",
          observationReasonCode: "UNKNOWN_FUTURE_REJECTION",
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when parser evidence conflicts with a non-swap classification", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          observationClassification: "TRANSFER",
          observationReasonCode: "PARSER_FAILURE",
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when exact non-swap reason and classification disagree", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          observationClassification: "LP",
          observationReasonCode: "ORDINARY_TRANSFER",
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when a definitive non-swap has later execution evidence", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          observationReasonCode: "ORDINARY_TRANSFER",
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER" }],
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it("fails closed when a copy skip has later Jupiter evidence", () => {
    expect(
      classifyOpportunityFailure(
        opportunity({
          followerTrade: {
            executionKey: "exec-1",
            state: "SKIPPED",
            structuredReasonCode: "SIZE_ROUNDED_TO_ZERO",
          },
          jupiterAttempts: [
            {
              executionKey: "exec-1",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 1n,
              route: [{ provider: "JUPITER" }],
            },
          ],
        }),
        policy,
      ),
    ).toEqual({
      classificationStatus: "UNAVAILABLE",
      primaryCategory: null,
      stage: null,
      reasonCode: "CONFLICTING_EVIDENCE",
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });
});

describe("projectPostQuoteFreshnessOutcome", () => {
  it.each([
    ["ALLOW", "ALLOW", "PASS"],
    ["REJECT", "ROUTE_INVALID", "PASS"],
    ["REJECT", "PRICE_IMPACT_UNAVAILABLE", "PASS"],
    ["REJECT", "RISK_POLICY_FOR_QUOTE_UNAVAILABLE", "PASS"],
    ["REJECT", "PRICE_IMPACT_TOO_HIGH", "PASS"],
    ["REJECT", "STALE_QUOTE", "STALE"],
    ["REJECT", "QUOTE_AMOUNT_MISMATCH", "BEFORE_FRESHNESS"],
  ] as const)(
    "projects POST %s/%s relative to the actual freshness gate as %s",
    (decision, reasonCode, expected) => {
      expect(
        projectPostQuoteFreshnessOutcome({
          intentId: "exec-1",
          phase: "POST_QUOTE",
          decision,
          reasonCode,
        }),
      ).toBe(expected);
    },
  );

  it("does not treat a PRE outcome as POST freshness evidence", () => {
    expect(
      projectPostQuoteFreshnessOutcome({
        intentId: "exec-1",
        phase: "PRE_QUOTE",
        decision: "REJECT",
        reasonCode: "STALE_QUOTE",
      }),
    ).toBe("UNAVAILABLE");
  });

  it("fails analytical projection closed for unsupported decision/reason pairs", () => {
    expect(
      projectPostQuoteFreshnessOutcome({
        intentId: "exec-1",
        phase: "POST_QUOTE",
        decision: "ALLOW",
        reasonCode: "PRICE_IMPACT_TOO_HIGH",
      }),
    ).toBe("UNAVAILABLE");
    expect(
      projectPostQuoteFreshnessOutcome({
        intentId: "exec-2",
        phase: "POST_QUOTE",
        decision: "REJECT",
        reasonCode: "ALLOW",
      }),
    ).toBe("UNAVAILABLE");
  });
});

describe("isTerminalOpportunityFailure", () => {
  it("marks only the four frozen classified failure categories as terminal", () => {
    const categories = [
      "EXECUTION_FAILURE",
      "MARKET_FAILURE",
      "RISK_REJECTION",
      "COPYABILITY_FAILURE",
    ] as const;

    for (const primaryCategory of categories) {
      expect(
        isTerminalOpportunityFailure({
          classificationStatus: "CLASSIFIED",
          primaryCategory,
          stage: "JUPITER_ORDER",
          reasonCode: "TERMINAL",
          definitionVersion: "OPPORTUNITY_FAILURE_V1",
        }),
      ).toBe(true);
    }
  });

  it("does not mark coverage, policy, unavailable, or successful outcomes terminal", () => {
    const classifications: readonly FailureClassification[] = [
      {
        classificationStatus: "CLASSIFIED",
        primaryCategory: "DATA_LIMITATION",
        stage: "OBSERVATION_CLASSIFICATION",
        reasonCode: "PARSER_FAILURE",
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      },
      {
        classificationStatus: "CLASSIFIED",
        primaryCategory: "POLICY_EXCLUSION",
        stage: "OBSERVATION_POLICY",
        reasonCode: "QUOTE_ASSET_NOT_ALLOWED",
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      },
      {
        classificationStatus: "UNAVAILABLE",
        primaryCategory: null,
        stage: null,
        reasonCode: "CONFLICTING_EVIDENCE",
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      },
      {
        classificationStatus: "NOT_A_FAILURE",
        primaryCategory: null,
        stage: "PAPER_APPLICATION",
        reasonCode: null,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      },
    ];

    for (const classification of classifications) {
      expect(isTerminalOpportunityFailure(classification)).toBe(false);
    }
  });
});
