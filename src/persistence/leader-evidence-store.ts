import type { Clock } from "../domain/time.js";
import type { Statement } from "better-sqlite3";
import { jsonStringify } from "../domain/json.js";
import type {
  LeaderAccountBalanceEvidence,
  LeaderInstructionEvidence,
  LeaderResearchEvidence,
} from "../research/leader-evidence.js";
import { SqliteDatabase } from "./database.js";

export type LeaderEvidenceAppendResult = {
  readonly status: "INSERTED" | "DUPLICATE" | "CONFLICT";
  readonly evidenceId: string;
};

export interface LeaderEvidenceSink {
  append(evidence: LeaderResearchEvidence): Promise<LeaderEvidenceAppendResult>;
}

export class LeaderEvidenceStore implements LeaderEvidenceSink {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  async append(
    evidence: LeaderResearchEvidence,
  ): Promise<LeaderEvidenceAppendResult> {
    return this.database.write((): LeaderEvidenceAppendResult =>
      this.database.sqlite.transaction(() => {
        const existing = this.database.sqlite
          .prepare(
            "SELECT source_fingerprint FROM leader_research_evidence WHERE leader_wallet_id = ? AND signature = ? AND source_fingerprint = ? AND extractor_version = ?",
          )
          .get(
            evidence.leaderWalletId,
            evidence.signature,
            evidence.sourceFingerprint,
            evidence.extractorVersion,
          ) as { source_fingerprint: string } | undefined;
        if (existing)
          return {
            status: "DUPLICATE" as const,
            evidenceId: evidence.evidenceId,
          };
        const conflicting =
          this.database.sqlite
            .prepare(
              "SELECT 1 FROM leader_research_evidence WHERE leader_wallet_id = ? AND signature = ? LIMIT 1",
            )
            .get(evidence.leaderWalletId, evidence.signature) !== undefined;
        const conflictStatus = conflicting
          ? "CONFLICT"
          : evidence.conflictStatus;
        this.database.sqlite
          .prepare(
            `
        INSERT INTO leader_research_evidence(
          evidence_id, leader_wallet_id, signature, slot, block_time_ms, block_time_status,
          transaction_index, transaction_index_status, event_ordinal, event_ordinal_status,
          signer, signers_json, fee_payer, source_provider, source_fingerprint, input_mint, output_mint,
          input_mint_canonical, output_mint_canonical, canonical_quote_mint, input_amount_raw,
          output_amount_raw, input_decimals, output_decimals, input_decimals_provenance,
          output_decimals_provenance, fee_raw, fee_mint, fee_attribution_status,
          priority_fee_raw, priority_fee_status, classification_code, trading_authorization, coverage_status,
          gap_status, conflict_status, backfill_status, schema_version, extractor_version,
          decoder_version, normalization_version, created_at_ms
        ) VALUES (${Array.from({ length: 42 }, () => "?").join(", ")})
      `,
          )
          .run(
            evidence.evidenceId,
            evidence.leaderWalletId,
            evidence.signature,
            evidence.slot,
            evidence.blockTimeMs,
            evidence.blockTimeStatus,
            evidence.transactionIndex,
            evidence.transactionIndexStatus,
            evidence.eventOrdinal,
            evidence.eventOrdinalStatus,
            evidence.signer,
            jsonStringify(evidence.signers),
            evidence.feePayer,
            evidence.sourceProvider,
            evidence.sourceFingerprint,
            evidence.inputMint,
            evidence.outputMint,
            evidence.inputMintCanonical,
            evidence.outputMintCanonical,
            evidence.canonicalQuoteMint,
            evidence.inputAmountRaw,
            evidence.outputAmountRaw,
            evidence.inputDecimals,
            evidence.outputDecimals,
            evidence.inputDecimalsProvenance,
            evidence.outputDecimalsProvenance,
            evidence.feeRaw,
            evidence.feeMint,
            evidence.feeAttributionStatus,
            evidence.priorityFeeRaw,
            evidence.priorityFeeStatus,
            evidence.classificationCode,
            evidence.tradingAuthorization,
            evidence.coverageStatus,
            evidence.gapStatus,
            conflictStatus,
            evidence.backfillStatus,
            evidence.schemaVersion,
            evidence.extractorVersion,
            evidence.decoderVersion,
            evidence.normalizationVersion,
            this.clock.now().wallMs,
          );
        const balanceInsert = this.database.sqlite.prepare(`
        INSERT INTO leader_research_account_balances(
          evidence_id, account_index, account_address, mint, token_program, pre_raw, post_raw,
          delta_raw, decimals, decimals_status, decimals_provenance, pre_owner, post_owner, owner_status, owner_provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
        for (const balance of evidence.accountBalances)
          this.insertBalance(balanceInsert, evidence.evidenceId, balance);
        const instructionInsert = this.database.sqlite.prepare(`
        INSERT INTO leader_research_instructions(
          evidence_id, capture_ordinal, kind, outer_ordinal, inner_ordinal, ordering_status, program_id,
          accounts_json, data, parsed_type, stack_height
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
        for (const instruction of evidence.instructions)
          instructionInsert.run(
            evidence.evidenceId,
            instruction.captureOrdinal,
            instruction.kind,
            instruction.outerOrdinal,
            instruction.innerOrdinal,
            instruction.orderingStatus,
            instruction.programId,
            jsonStringify(instruction.accounts),
            instruction.data,
            instruction.parsedType,
            instruction.stackHeight,
          );
        const status: LeaderEvidenceAppendResult["status"] =
          conflictStatus === "CONFLICT" ? "CONFLICT" : "INSERTED";
        return { status, evidenceId: evidence.evidenceId };
      })(),
    );
  }

  read(evidenceId: string): LeaderResearchEvidence | undefined {
    const row = this.database.sqlite
      .prepare("SELECT * FROM leader_research_evidence WHERE evidence_id = ?")
      .get(evidenceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const balances = this.database.sqlite
      .prepare(
        "SELECT * FROM leader_research_account_balances WHERE evidence_id = ? ORDER BY account_index, mint",
      )
      .all(evidenceId) as Record<string, unknown>[];
    const instructions = this.database.sqlite
      .prepare(
        "SELECT * FROM leader_research_instructions WHERE evidence_id = ? ORDER BY CASE kind WHEN 'OUTER' THEN 0 ELSE 1 END, outer_ordinal, inner_ordinal",
      )
      .all(evidenceId) as Record<string, unknown>[];
    return {
      evidenceId: String(row.evidence_id),
      schemaVersion: String(row.schema_version),
      extractorVersion: String(row.extractor_version),
      decoderVersion: String(row.decoder_version),
      normalizationVersion: String(row.normalization_version),
      leaderWalletId: String(row.leader_wallet_id),
      signature: String(row.signature),
      slot: String(row.slot),
      blockTimeMs: row.block_time_ms as number | null,
      blockTimeStatus:
        row.block_time_status as LeaderResearchEvidence["blockTimeStatus"],
      transactionIndex: row.transaction_index as number | null,
      transactionIndexStatus:
        row.transaction_index_status as LeaderResearchEvidence["transactionIndexStatus"],
      eventOrdinal: row.event_ordinal as number | null,
      eventOrdinalStatus:
        row.event_ordinal_status as LeaderResearchEvidence["eventOrdinalStatus"],
      signer: row.signer as string | null,
      signers: JSON.parse(String(row.signers_json)) as string[],
      feePayer: row.fee_payer as string | null,
      sourceProvider: String(row.source_provider),
      sourceFingerprint: String(row.source_fingerprint),
      inputMint: row.input_mint as string | null,
      outputMint: row.output_mint as string | null,
      inputMintCanonical: row.input_mint_canonical as string | null,
      outputMintCanonical: row.output_mint_canonical as string | null,
      canonicalQuoteMint: row.canonical_quote_mint as string | null,
      inputAmountRaw: row.input_amount_raw as string | null,
      outputAmountRaw: row.output_amount_raw as string | null,
      inputDecimals: row.input_decimals as number | null,
      outputDecimals: row.output_decimals as number | null,
      inputDecimalsProvenance:
        row.input_decimals_provenance as LeaderResearchEvidence["inputDecimalsProvenance"],
      outputDecimalsProvenance:
        row.output_decimals_provenance as LeaderResearchEvidence["outputDecimalsProvenance"],
      feeRaw: row.fee_raw as string | null,
      feeMint: String(row.fee_mint) as LeaderResearchEvidence["feeMint"],
      feeAttributionStatus:
        row.fee_attribution_status as LeaderResearchEvidence["feeAttributionStatus"],
      priorityFeeRaw: row.priority_fee_raw as string | null,
      priorityFeeStatus:
        row.priority_fee_status as LeaderResearchEvidence["priorityFeeStatus"],
      classificationCode: String(row.classification_code),
      tradingAuthorization:
        row.trading_authorization as LeaderResearchEvidence["tradingAuthorization"],
      coverageStatus:
        row.coverage_status as LeaderResearchEvidence["coverageStatus"],
      gapStatus: row.gap_status as LeaderResearchEvidence["gapStatus"],
      conflictStatus:
        row.conflict_status as LeaderResearchEvidence["conflictStatus"],
      backfillStatus:
        row.backfill_status as LeaderResearchEvidence["backfillStatus"],
      accountBalances: balances.map((item) => ({
        accountIndex: Number(item.account_index),
        accountAddress: item.account_address as string | null,
        mint: String(item.mint),
        tokenProgram:
          item.token_program as LeaderAccountBalanceEvidence["tokenProgram"],
        preRaw: item.pre_raw as string | null,
        postRaw: item.post_raw as string | null,
        deltaRaw: item.delta_raw as string | null,
        decimals: item.decimals as number | null,
        decimalsStatus:
          item.decimals_status as LeaderAccountBalanceEvidence["decimalsStatus"],
        decimalsProvenance:
          item.decimals_provenance as LeaderAccountBalanceEvidence["decimalsProvenance"],
        preOwner: item.pre_owner as string | null,
        postOwner: item.post_owner as string | null,
        ownerStatus:
          item.owner_status as LeaderAccountBalanceEvidence["ownerStatus"],
        ownerProvenance:
          item.owner_provenance as LeaderAccountBalanceEvidence["ownerProvenance"],
      })),
      instructions: instructions.map((item) => ({
        captureOrdinal: Number(item.capture_ordinal),
        kind: item.kind as LeaderInstructionEvidence["kind"],
        outerOrdinal: item.outer_ordinal as number | null,
        innerOrdinal: item.inner_ordinal as number | null,
        orderingStatus:
          item.ordering_status as LeaderInstructionEvidence["orderingStatus"],
        programId: String(item.program_id),
        accounts: JSON.parse(String(item.accounts_json)) as string[],
        data: item.data as string | null,
        parsedType: item.parsed_type as string | null,
        stackHeight: item.stack_height as number | null,
      })),
    };
  }

  private insertBalance(
    statement: Statement,
    evidenceId: string,
    balance: LeaderAccountBalanceEvidence,
  ): void {
    statement.run(
      evidenceId,
      balance.accountIndex,
      balance.accountAddress,
      balance.mint,
      balance.tokenProgram,
      balance.preRaw,
      balance.postRaw,
      balance.deltaRaw,
      balance.decimals,
      balance.decimalsStatus,
      balance.decimalsProvenance,
      balance.preOwner,
      balance.postOwner,
      balance.ownerStatus,
      balance.ownerProvenance,
    );
  }
}
