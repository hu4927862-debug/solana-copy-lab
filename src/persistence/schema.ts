import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const wallets = sqliteTable(
  "wallets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    address: text("address").notNull(),
    role: text("role", { enum: ["LEADER", "FOLLOWER"] }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    copyRatioBps: integer("copy_ratio_bps").notNull().default(10_000),
    maxQuoteRaw: text("max_quote_raw"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [uniqueIndex("wallets_address_unique").on(table.address)],
);

export const tokens = sqliteTable("tokens", {
  mint: text("mint").primaryKey(),
  symbol: text("symbol"),
  decimals: integer("decimals"),
  tokenProgram: text("token_program"),
  isQuote: integer("is_quote", { mode: "boolean" }).notNull().default(false),
  unsupportedReason: text("unsupported_reason"),
  firstSeenAtMs: integer("first_seen_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const leaderTrades = sqliteTable(
  "leader_trades",
  {
    id: text("id").primaryKey(),
    leaderWalletId: integer("leader_wallet_id")
      .notNull()
      .references(() => wallets.id),
    signature: text("signature").notNull(),
    eventIndex: integer("event_index").notNull().default(0),
    slot: text("slot").notNull(),
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    tokenMint: text("token_mint")
      .notNull()
      .references(() => tokens.mint),
    quoteMint: text("quote_mint")
      .notNull()
      .references(() => tokens.mint),
    tokenRaw: text("token_raw").notNull(),
    quoteRaw: text("quote_raw").notNull(),
    leaderPreTokenRaw: text("leader_pre_token_raw").notNull(),
    sourcePrice: text("source_price"),
    sourceTimestampMs: integer("source_timestamp_ms"),
    sourceTimestampPrecision: text("source_timestamp_precision").notNull(),
    sourceTimestampProvenance: text("source_timestamp_provenance", {
      enum: ["CHAIN_BLOCK_TIME", "UNKNOWN"],
    })
      .notNull()
      .default("UNKNOWN"),
    streamReceivedTimestampMs: integer(
      "stream_received_timestamp_ms",
    ).notNull(),
    detectedTimestampMs: integer("detected_timestamp_ms").notNull(),
    decodedTimestampMs: integer("decoded_timestamp_ms").notNull(),
    streamReceivedMonotonicNs: text("stream_received_monotonic_ns").notNull(),
    detectedMonotonicNs: text("detected_monotonic_ns").notNull(),
    decodedMonotonicNs: text("decoded_monotonic_ns").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("leader_trade_source_unique").on(
      table.leaderWalletId,
      table.signature,
      table.eventIndex,
    ),
  ],
);

export const followerTrades = sqliteTable(
  "follower_trades",
  {
    id: text("id").primaryKey(),
    executionKey: text("execution_key").notNull(),
    leaderTradeId: text("leader_trade_id")
      .notNull()
      .references(() => leaderTrades.id),
    followerWalletId: integer("follower_wallet_id")
      .notNull()
      .references(() => wallets.id),
    state: text("state").notNull(),
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    tokenMint: text("token_mint")
      .notNull()
      .references(() => tokens.mint),
    quoteMint: text("quote_mint")
      .notNull()
      .references(() => tokens.mint),
    theoreticalTokenRaw: text("theoretical_token_raw").notNull(),
    theoreticalQuoteRaw: text("theoretical_quote_raw").notNull(),
    executedTokenRaw: text("executed_token_raw"),
    executedQuoteRaw: text("executed_quote_raw"),
    copyRatioBps: integer("copy_ratio_bps").notNull(),
    sellRatioNumerator: text("sell_ratio_numerator"),
    sellRatioDenominator: text("sell_ratio_denominator"),
    skipReason: text("skip_reason"),
    sourcePrice: text("source_price"),
    executionPrice: text("execution_price"),
    priceDifferencePct: text("price_difference_pct"),
    orderCreatedTimestampMs: integer("order_created_timestamp_ms").notNull(),
    orderCreatedMonotonicNs: text("order_created_monotonic_ns").notNull(),
    orderSignedTimestampMs: integer("order_signed_timestamp_ms"),
    orderSignedMonotonicNs: text("order_signed_monotonic_ns"),
    orderSentTimestampMs: integer("order_sent_timestamp_ms"),
    orderSentMonotonicNs: text("order_sent_monotonic_ns"),
    confirmedTimestampMs: integer("confirmed_timestamp_ms"),
    confirmedMonotonicNs: text("confirmed_monotonic_ns"),
    finalizedTimestampMs: integer("finalized_timestamp_ms"),
    finalizedMonotonicNs: text("finalized_monotonic_ns"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("follower_execution_key_unique").on(table.executionKey),
    uniqueIndex("follower_trade_mapping_unique").on(
      table.leaderTradeId,
      table.followerWalletId,
    ),
  ],
);

export const leaderPositions = sqliteTable(
  "leader_positions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leaderWalletId: integer("leader_wallet_id")
      .notNull()
      .references(() => wallets.id),
    tokenMint: text("token_mint")
      .notNull()
      .references(() => tokens.mint),
    rawAmount: text("raw_amount").notNull(),
    state: text("state", { enum: ["OPEN", "CLOSED"] }).notNull(),
    lastTradeId: text("last_trade_id").references(() => leaderTrades.id),
    version: integer("version").notNull().default(0),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("leader_position_unique").on(
      table.leaderWalletId,
      table.tokenMint,
    ),
  ],
);

export const leaderResearchEvidence = sqliteTable("leader_research_evidence", {
  evidenceId: text("evidence_id").primaryKey(),
  leaderWalletId: text("leader_wallet_id").notNull(),
  signature: text("signature").notNull(),
  slot: text("slot").notNull(),
  blockTimeMs: integer("block_time_ms"),
  blockTimeStatus: text("block_time_status").notNull(),
  transactionIndex: integer("transaction_index"),
  transactionIndexStatus: text("transaction_index_status").notNull(),
  eventOrdinal: integer("event_ordinal"),
  eventOrdinalStatus: text("event_ordinal_status").notNull(),
  signer: text("signer"),
  signersJson: text("signers_json").notNull(),
  feePayer: text("fee_payer"),
  sourceProvider: text("source_provider").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull(),
  inputMint: text("input_mint"),
  outputMint: text("output_mint"),
  inputMintCanonical: text("input_mint_canonical"),
  outputMintCanonical: text("output_mint_canonical"),
  canonicalQuoteMint: text("canonical_quote_mint"),
  inputAmountRaw: text("input_amount_raw"),
  outputAmountRaw: text("output_amount_raw"),
  inputDecimals: integer("input_decimals"),
  outputDecimals: integer("output_decimals"),
  inputDecimalsProvenance: text("input_decimals_provenance").notNull(),
  outputDecimalsProvenance: text("output_decimals_provenance").notNull(),
  feeRaw: text("fee_raw"),
  feeMint: text("fee_mint").notNull(),
  feeAttributionStatus: text("fee_attribution_status").notNull(),
  priorityFeeRaw: text("priority_fee_raw"),
  priorityFeeStatus: text("priority_fee_status").notNull(),
  classificationCode: text("classification_code").notNull(),
  tradingAuthorization: text("trading_authorization").notNull(),
  coverageStatus: text("coverage_status").notNull(),
  gapStatus: text("gap_status").notNull(),
  conflictStatus: text("conflict_status").notNull(),
  backfillStatus: text("backfill_status").notNull(),
  schemaVersion: text("schema_version").notNull(),
  extractorVersion: text("extractor_version").notNull(),
  decoderVersion: text("decoder_version").notNull(),
  normalizationVersion: text("normalization_version").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const leaderResearchAccountBalances = sqliteTable(
  "leader_research_account_balances",
  {
    evidenceId: text("evidence_id").notNull(),
    accountIndex: integer("account_index").notNull(),
    accountAddress: text("account_address"),
    mint: text("mint").notNull(),
    tokenProgram: text("token_program").notNull(),
    preRaw: text("pre_raw"),
    postRaw: text("post_raw"),
    deltaRaw: text("delta_raw"),
    decimals: integer("decimals"),
    decimalsStatus: text("decimals_status").notNull(),
    decimalsProvenance: text("decimals_provenance").notNull(),
    preOwner: text("pre_owner"),
    postOwner: text("post_owner"),
    ownerStatus: text("owner_status").notNull(),
    ownerProvenance: text("owner_provenance").notNull(),
  },
);

export const leaderResearchInstructions = sqliteTable(
  "leader_research_instructions",
  {
    evidenceId: text("evidence_id").notNull(),
    captureOrdinal: integer("capture_ordinal").notNull(),
    kind: text("kind").notNull(),
    outerOrdinal: integer("outer_ordinal"),
    innerOrdinal: integer("inner_ordinal"),
    orderingStatus: text("ordering_status").notNull(),
    programId: text("program_id").notNull(),
    accountsJson: text("accounts_json").notNull(),
    data: text("data"),
    parsedType: text("parsed_type"),
    stackHeight: integer("stack_height"),
  },
);

export const executionRealismDelayedQuotes = sqliteTable(
  "execution_realism_delayed_quotes",
  {
    evidenceId: text("evidence_id").primaryKey(),
    parentExecutionKey: text("parent_execution_key").notNull(),
    validationEventId: text("validation_event_id").notNull(),
    policyVersion: text("policy_version").notNull(),
    referenceTimestampMs: integer("reference_timestamp_ms").notNull(),
    intendedDelayMs: integer("intended_delay_ms").notNull(),
    actualRequestTimestampMs: integer("actual_request_timestamp_ms").notNull(),
    actualResponseTimestampMs: integer("actual_response_timestamp_ms"),
    actualObservedDelayMs: integer("actual_observed_delay_ms").notNull(),
    requestMonotonicNs: text("request_monotonic_ns"),
    responseMonotonicNs: text("response_monotonic_ns"),
    inputMint: text("input_mint").notNull(),
    outputMint: text("output_mint").notNull(),
    inputAmountRaw: text("input_amount_raw").notNull(),
    returnedInputAmountRaw: text("returned_input_amount_raw"),
    returnedInputAmountStatus: text("returned_input_amount_status").notNull(),
    returnedOutputAmountRaw: text("returned_output_amount_raw"),
    jupiterRequestId: text("jupiter_request_id"),
    swapMode: text("swap_mode"),
    httpStatus: integer("http_status"),
    schemaValid: integer("schema_valid", { mode: "boolean" }).notNull(),
    router: text("router"),
    routeJson: text("route_json"),
    routeStatus: text("route_status").notNull(),
    priceImpactPct: text("price_impact_pct"),
    outcome: text("outcome").notNull(),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    sourceFingerprint: text("source_fingerprint").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("execution_realism_delayed_quote_unique").on(
      table.parentExecutionKey,
      table.policyVersion,
      table.intendedDelayMs,
    ),
  ],
);

export const followerPositions = sqliteTable(
  "follower_positions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    followerWalletId: integer("follower_wallet_id")
      .notNull()
      .references(() => wallets.id),
    leaderWalletId: integer("leader_wallet_id")
      .notNull()
      .references(() => wallets.id),
    tokenMint: text("token_mint")
      .notNull()
      .references(() => tokens.mint),
    rawAmount: text("raw_amount").notNull(),
    reservedRawAmount: text("reserved_raw_amount").notNull().default("0"),
    state: text("state", { enum: ["OPEN", "CLOSED"] }).notNull(),
    lastExecutionKey: text("last_execution_key"),
    version: integer("version").notNull().default(0),
    updatedAtMs: integer("updated_at_ms").notNull(),
    quoteMint: text("quote_mint").references(() => tokens.mint),
    totalCostQuoteRaw: text("total_cost_quote_raw"),
    realizedPnlQuoteRaw: text("realized_pnl_quote_raw"),
    accountingPolicyVersion: text("accounting_policy_version"),
    openedAtMs: integer("opened_at_ms"),
    closedAtMs: integer("closed_at_ms"),
    lastFillId: text("last_fill_id"),
  },
  (table) => [
    uniqueIndex("follower_position_unique").on(
      table.followerWalletId,
      table.leaderWalletId,
      table.tokenMint,
      table.quoteMint,
    ),
  ],
);

export const paperFills = sqliteTable(
  "paper_fills",
  {
    id: text("id").primaryKey(),
    intentId: text("intent_id")
      .notNull()
      .references(() => followerTrades.executionKey),
    leaderTradeId: text("leader_trade_id")
      .notNull()
      .references(() => leaderTrades.id),
    leaderTxSignature: text("leader_tx_signature").notNull(),
    leaderWallet: text("leader_wallet").notNull(),
    followerWallet: text("follower_wallet").notNull(),
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    inputMint: text("input_mint").notNull(),
    outputMint: text("output_mint").notNull(),
    tokenDecimals: integer("token_decimals").notNull(),
    quoteDecimals: integer("quote_decimals").notNull(),
    inputAmountRaw: text("input_amount_raw").notNull(),
    outputAmountRaw: text("output_amount_raw").notNull(),
    quoteRequestTimestampMs: integer("quote_request_timestamp_ms").notNull(),
    quoteTimestampMs: integer("quote_timestamp_ms").notNull(),
    quoteRttMs: real("quote_rtt_ms").notNull(),
    feeEvidenceStatus: text("fee_evidence_status", {
      enum: ["AVAILABLE", "AMOUNT_UNAVAILABLE"],
    }).notNull(),
    feeEvidenceContractId: text("fee_evidence_contract_id"),
    feeBps: integer("fee_bps"),
    feeMint: text("fee_mint"),
    feeAmountRaw: text("fee_amount_raw"),
    provider: text("provider").notNull(),
    requestId: text("request_id"),
    fillPolicyVersion: text("fill_policy_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("paper_fills_intent_unique").on(table.intentId),
    uniqueIndex("paper_fills_source_unique").on(
      table.leaderTradeId,
      table.followerWallet,
      table.fillPolicyVersion,
    ),
  ],
);

export const paperFillApplications = sqliteTable("paper_fill_applications", {
  fillId: text("fill_id")
    .primaryKey()
    .references(() => paperFills.id),
  positionId: integer("position_id")
    .notNull()
    .references(() => followerPositions.id),
  transition: text("transition", {
    enum: ["OPEN", "ADD", "REDUCE", "CLOSE"],
  }).notNull(),
  quantityBeforeRaw: text("quantity_before_raw").notNull(),
  quantityAfterRaw: text("quantity_after_raw").notNull(),
  totalCostBeforeRaw: text("total_cost_before_raw").notNull(),
  totalCostAfterRaw: text("total_cost_after_raw").notNull(),
  allocatedCostBasisRaw: text("allocated_cost_basis_raw").notNull(),
  proceedsRaw: text("proceeds_raw").notNull(),
  realizedPnlDeltaRaw: text("realized_pnl_delta_raw").notNull(),
  realizedPnlAfterRaw: text("realized_pnl_after_raw").notNull(),
  positionVersionAfter: integer("position_version_after").notNull(),
  appliedAtMs: integer("applied_at_ms").notNull(),
});

export const executionEvents = sqliteTable(
  "execution_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    executionKey: text("execution_key").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    detailsJson: text("details_json").notNull(),
    wallTimestampMs: integer("wall_timestamp_ms").notNull(),
    monotonicTimestampNs: text("monotonic_timestamp_ns").notNull(),
  },
  (table) => [
    uniqueIndex("execution_event_sequence_unique").on(
      table.executionKey,
      table.sequence,
    ),
  ],
);

export const systemEvents = sqliteTable("system_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  severity: text("severity").notNull(),
  component: text("component").notNull(),
  message: text("message").notNull(),
  detailsJson: text("details_json").notNull(),
  wallTimestampMs: integer("wall_timestamp_ms").notNull(),
  monotonicTimestampNs: text("monotonic_timestamp_ns").notNull(),
});

export const streamCheckpoints = sqliteTable(
  "stream_checkpoints",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    subscriptionKey: text("subscription_key").notNull(),
    slot: text("slot").notNull(),
    signature: text("signature"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("stream_checkpoint_unique").on(
      table.provider,
      table.subscriptionKey,
    ),
  ],
);

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: text("version").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAtMs: integer("applied_at_ms").notNull(),
});

export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventKey: text("event_key").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    availableAtMs: integer("available_at_ms").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    publishedAtMs: integer("published_at_ms"),
  },
  (table) => [uniqueIndex("outbox_event_key_unique").on(table.eventKey)],
);

export const providerReceipts = sqliteTable(
  "provider_receipts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    signature: text("signature").notNull(),
    provider: text("provider").notNull(),
    slot: text("slot").notNull(),
    receivedTimestampMs: integer("received_timestamp_ms").notNull(),
    receivedMonotonicNs: text("received_monotonic_ns").notNull(),
    isReplay: integer("is_replay", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("provider_receipt_unique").on(table.signature, table.provider),
  ],
);

export const providerEventComparisons = sqliteTable(
  "provider_event_comparisons",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    signature: text("signature").notNull().unique(),
    primaryProvider: text("primary_provider").notNull(),
    secondaryProvider: text("secondary_provider").notNull(),
    primaryReceivedTimestampMs: integer("primary_received_timestamp_ms"),
    secondaryReceivedTimestampMs: integer("secondary_received_timestamp_ms"),
    arrivalDeltaMs: integer("arrival_delta_ms", { mode: "number" }),
    status: text("status").notNull(),
    comparedAtMs: integer("compared_at_ms").notNull(),
  },
);

export const streamHealthEvents = sqliteTable("stream_health_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  durationMs: integer("duration_ms", { mode: "number" }),
  detailsJson: text("details_json").notNull(),
  wallTimestampMs: integer("wall_timestamp_ms").notNull(),
  monotonicTimestampNs: text("monotonic_timestamp_ns").notNull(),
});

export const liveValidationEvents = sqliteTable(
  "live_validation_events",
  {
    id: text("id").primaryKey(),
    signature: text("signature").notNull(),
    eventIndex: integer("event_index").notNull().default(0),
    slot: text("slot").notNull(),
    blockTimeMs: integer("block_time_ms"),
    leader: text("leader").notNull(),
    primaryProvider: text("primary_provider").notNull(),
    programIdsJson: text("program_ids_json").notNull(),
    systemClassification: text("system_classification").notNull(),
    groundTruthClassification: text("ground_truth_classification").notNull(),
    groundTruthSource: text("ground_truth_source").notNull(),
    dex: text("dex"),
    tokenMint: text("token_mint"),
    quoteMint: text("quote_mint"),
    balanceDeltasJson: text("balance_deltas_json").notNull(),
    classifierEvidenceJson: text("classifier_evidence_json").notNull(),
    skipReason: text("skip_reason"),
    capturePath: text("capture_path").notNull(),
    decodeError: text("decode_error"),
    isDuplicate: integer("is_duplicate", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAtMs: integer("created_at_ms").notNull(),
    reviewedAtMs: integer("reviewed_at_ms"),
  },
  (table) => [
    uniqueIndex("live_validation_source_unique").on(
      table.signature,
      table.leader,
      table.eventIndex,
    ),
  ],
);

export const reviewQueue = sqliteTable("review_queue", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  validationEventId: text("validation_event_id")
    .notNull()
    .unique()
    .references(() => liveValidationEvents.id),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("PENDING"),
  proposedClassification: text("proposed_classification"),
  humanClassification: text("human_classification"),
  notes: text("notes"),
  createdAtMs: integer("created_at_ms").notNull(),
  reviewedAtMs: integer("reviewed_at_ms"),
});

export const liveLatencySamples = sqliteTable("live_latency_samples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  validationEventId: text("validation_event_id")
    .notNull()
    .unique()
    .references(() => liveValidationEvents.id),
  streamReceivedMonotonicNs: text("stream_received_monotonic_ns").notNull(),
  detectedMonotonicNs: text("detected_monotonic_ns"),
  normalizedMonotonicNs: text("normalized_monotonic_ns"),
  classifiedMonotonicNs: text("classified_monotonic_ns"),
  copyIntentCreatedMonotonicNs: text("copy_intent_created_monotonic_ns"),
  jupiterRequestStartedMonotonicNs: text(
    "jupiter_request_started_monotonic_ns",
  ),
  jupiterResponseReceivedMonotonicNs: text(
    "jupiter_response_received_monotonic_ns",
  ),
  shadowExecutionCompletedMonotonicNs: text(
    "shadow_execution_completed_monotonic_ns",
  ),
  streamToDecodeMs: integer("stream_to_decode_ms", { mode: "number" }),
  decodeToDecisionMs: integer("decode_to_decision_ms", { mode: "number" }),
  decisionToJupiterRequestMs: integer("decision_to_jupiter_request_ms", {
    mode: "number",
  }),
  jupiterRttMs: integer("jupiter_rtt_ms", { mode: "number" }),
  fullShadowPipelineMs: integer("full_shadow_pipeline_ms", { mode: "number" }),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const jupiterShadowQuotes = sqliteTable("jupiter_shadow_quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  validationEventId: text("validation_event_id")
    .notNull()
    .references(() => liveValidationEvents.id),
  executionKey: text("execution_key").notNull().unique(),
  requestTimestampMs: integer("request_timestamp_ms").notNull(),
  responseTimestampMs: integer("response_timestamp_ms"),
  requestMonotonicNs: text("request_monotonic_ns").notNull(),
  responseMonotonicNs: text("response_monotonic_ns"),
  httpStatus: integer("http_status"),
  schemaValid: integer("schema_valid", { mode: "boolean" })
    .notNull()
    .default(false),
  inputMint: text("input_mint").notNull(),
  outputMint: text("output_mint").notNull(),
  inputRaw: text("input_raw").notNull(),
  expectedOutputRaw: text("expected_output_raw"),
  router: text("router"),
  routeJson: text("route_json"),
  priceImpactPct: text("price_impact_pct"),
  quoteAgeMs: integer("quote_age_ms", { mode: "number" }),
  rttMs: integer("rtt_ms", { mode: "number" }),
  sourcePrice: text("source_price"),
  expectedExecutionPrice: text("expected_execution_price"),
  theoreticalPriceDifferencePct: text("theoretical_price_difference_pct"),
  adversePriceDifferencePct: text("adverse_price_difference_pct"),
  provider: text("provider"),
  dex: text("dex"),
  tokenMint: text("token_mint"),
  leader: text("leader"),
  observedHour: text("observed_hour"),
  failureReason: text("failure_reason"),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const soakMetrics = sqliteTable("soak_metrics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sampledAtMs: integer("sampled_at_ms").notNull(),
  dbSizeBytes: integer("db_size_bytes").notNull(),
  walSizeBytes: integer("wal_size_bytes").notNull(),
  writerQueueSize: integer("writer_queue_size").notNull(),
  writerPending: integer("writer_pending").notNull(),
  busyErrorCount: integer("busy_error_count").notNull(),
  writeLatencyAverageMs: integer("write_latency_average_ms", {
    mode: "number",
  }).notNull(),
  writeLatencyP95Ms: integer("write_latency_p95_ms", {
    mode: "number",
  }).notNull(),
  walCheckpointDurationMs: integer("wal_checkpoint_duration_ms", {
    mode: "number",
  }),
  walCheckpointBusy: integer("wal_checkpoint_busy"),
  walCheckpointLogFrames: integer("wal_checkpoint_log_frames"),
  walCheckpointedFrames: integer("wal_checkpointed_frames"),
});

export const recoveryValidationRuns = sqliteTable("recovery_validation_runs", {
  id: text("id").primaryKey(),
  scenario: text("scenario").notNull(),
  startedAtMs: integer("started_at_ms").notNull(),
  completedAtMs: integer("completed_at_ms"),
  eventsDuringOutage: integer("events_during_outage").notNull().default(0),
  recoveredEvents: integer("recovered_events").notNull().default(0),
  lostEvents: integer("lost_events").notNull().default(0),
  duplicateEvents: integer("duplicate_events").notNull().default(0),
  replayCount: integer("replay_count").notNull().default(0),
  replaySuccessCount: integer("replay_success_count").notNull().default(0),
  status: text("status").notNull(),
  detailsJson: text("details_json").notNull(),
});

export const riskDecisions = sqliteTable(
  "risk_decisions",
  {
    decisionId: text("decision_id").primaryKey(),
    phase: text("phase", { enum: ["PRE_QUOTE", "POST_QUOTE"] }).notNull(),
    intentId: text("intent_id").notNull(),
    leaderTradeId: text("leader_trade_id"),
    leaderWallet: text("leader_wallet"),
    followerWallet: text("follower_wallet"),
    side: text("side", { enum: ["BUY", "SELL"] }),
    tokenMint: text("token_mint"),
    quoteMint: text("quote_mint"),
    preDecisionId: text("pre_decision_id"),
    quoteRequestId: text("quote_request_id"),
    decision: text("decision", {
      enum: ["ALLOW", "RESIZE", "REJECT", "HALT"],
    }).notNull(),
    requestedAmountRaw: text("requested_amount_raw").notNull(),
    approvedAmountRaw: text("approved_amount_raw").notNull(),
    requestedTokenRaw: text("requested_token_raw").notNull(),
    approvedTokenRaw: text("approved_token_raw").notNull(),
    requestedQuoteRaw: text("requested_quote_raw").notNull(),
    approvedQuoteRaw: text("approved_quote_raw").notNull(),
    reasonCode: text("reason_code").notNull(),
    policyVersion: text("policy_version").notNull(),
    relevantLimitRaw: text("relevant_limit_raw"),
    relevantEvidenceJson: text("relevant_evidence_json")
      .notNull()
      .default("{}"),
    decidedAtMs: integer("decided_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("risk_decisions_phase_intent_unique").on(
      table.phase,
      table.intentId,
    ),
  ],
);

export const riskState = sqliteTable("risk_state", {
  quoteMint: text("quote_mint").primaryKey(),
  quoteState: text("quote_state", {
    enum: ["RUNNING", "HALT_NEW_RISK"],
  }).notNull(),
  utcDay: text("utc_day").notNull(),
  dailyRealizedPnlRaw: text("daily_realized_pnl_raw").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull().default(0),
});

export const riskGlobalState = sqliteTable("risk_global_state", {
  singletonId: integer("singleton_id").primaryKey(),
  globalState: text("global_state", {
    enum: ["RUNNING", "HALT_NEW_RISK"],
  }).notNull(),
  reasonCode: text("reason_code").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull().default(0),
});

export const riskBuyReservations = sqliteTable("risk_buy_reservations", {
  intentId: text("intent_id").primaryKey(),
  followerWallet: text("follower_wallet"),
  leaderWallet: text("leader_wallet"),
  tokenMint: text("token_mint").notNull(),
  quoteMint: text("quote_mint").notNull(),
  approvedQuoteRaw: text("approved_quote_raw").notNull(),
  state: text("state", {
    enum: ["ACTIVE", "RELEASED", "APPLIED"],
  }).notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const riskProviderHealth = sqliteTable("risk_provider_health", {
  provider: text("provider").primaryKey(),
  stateJson: text("state_json").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const streamPendingDeliveries = sqliteTable(
  "stream_pending_deliveries",
  {
    provider: text("provider").notNull(),
    subscriptionKey: text("subscription_key").notNull(),
    signature: text("signature").notNull(),
    slot: text("slot").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.provider, table.subscriptionKey, table.signature],
    }),
  ],
);
