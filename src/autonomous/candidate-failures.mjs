// Only deterministic, pre-send candidate/economic refusals. Transport,
// identity, accounting and any possibly submitted transaction remain faults.
const CANDIDATE_CODES = new Set([
  'SOURCE_STALE', 'RUNTIME_SOURCE_EXPIRED', 'LEADER_ALREADY_SOLD',
  'LEADER_SELL_COVERAGE_UNPROVEN', 'EXECUTION_TOKEN_PROGRAM_UNQUALIFIED',
  'EXECUTION_POOL_UNQUALIFIED', 'EXIT_AUTHORITY_OR_PROVIDER_RESERVE_TOO_SHORT',
  'DAMM_NOT_ACTIVE', 'DAMM_QUOTE_NOT_EXACT_IN', 'DAMM_QUOTE_UNAVAILABLE',
  'LIVE_PRICE_IMPACT_GATE', 'PREFLIGHT_QUOTE_EXPIRED', 'BLOCKHASH_EXPIRED',
  'EXECUTION_CHASE_MINIMUM_OUTPUT',
  'INSUFFICIENT_BUY_AND_EXIT_RESERVE', 'SIMULATION_ECONOMIC_SCOPE',
  'SIMULATION_FEE_RENT_SCOPE', 'SIMULATION_EXIT_RESERVE',
]);
export function candidateFailure(error) {
  return error instanceof Error && CANDIDATE_CODES.has(error.message)
    ? error.message : null;
}
