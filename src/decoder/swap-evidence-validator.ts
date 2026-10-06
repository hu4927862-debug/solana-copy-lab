import type { DexName } from "../domain/trades.js";
import { decodeKnownInstruction } from "./instruction-decoder.js";
import { dexForProgram } from "./program-registry.js";
import type { NormalizedTransaction } from "./transaction-normalizer.js";

const SWAP_WORDS = /(?:^|[_:\s-])(swap|route|buy|sell)/i;
const LIQUIDITY_WORDS =
  /(add|remove|increase|decrease)[_\s-]*liquidity|deposit|withdraw|initializepool/i;
const STAKE_LENDING_WORDS = /stake|unstake|borrow|repay|lending|flashloan/i;
const TRANSFER_WORDS = /^(transfer|transferchecked|transfer_checked)$/i;

export interface SwapEvidenceResult {
  readonly dex?: DexName;
  readonly evidence: readonly string[];
  readonly hasKnownProgram: boolean;
  readonly hasSwapEvidence: boolean;
  readonly ordinaryTransfer: boolean;
  readonly liquidityOperation: boolean;
  readonly stakeOrLending: boolean;
}

export class SwapEvidenceValidator {
  validate(transaction: NormalizedTransaction): SwapEvidenceResult {
    const instructions = [
      ...transaction.outerInstructions,
      ...transaction.innerInstructions,
    ];
    let dex: DexName | undefined;
    const evidence: string[] = [];
    let ordinaryTransfer = false;
    let liquidityOperation = false;
    let stakeOrLending = false;

    for (const instruction of instructions) {
      const instructionDex = dexForProgram(instruction.programId);
      if (instructionDex && !dex) dex = instructionDex;
      const parsed =
        instruction.parsedType ??
        decodeKnownInstruction(instruction.programId, instruction.data) ??
        "";
      if (TRANSFER_WORDS.test(parsed)) ordinaryTransfer = true;
      if (LIQUIDITY_WORDS.test(parsed)) liquidityOperation = true;
      if (STAKE_LENDING_WORDS.test(parsed)) stakeOrLending = true;
      if (instructionDex && SWAP_WORDS.test(parsed)) {
        evidence.push(`${instructionDex}:instruction:${parsed}`);
      }
    }

    for (const log of transaction.logMessages) {
      if (LIQUIDITY_WORDS.test(log)) liquidityOperation = true;
      if (STAKE_LENDING_WORDS.test(log)) stakeOrLending = true;
      if (dex && SWAP_WORDS.test(log))
        evidence.push(`${dex}:log:${log.slice(0, 120)}`);
    }

    return {
      ...(dex === undefined ? {} : { dex }),
      evidence,
      hasKnownProgram: dex !== undefined,
      hasSwapEvidence: evidence.length > 0,
      ordinaryTransfer: ordinaryTransfer && dex === undefined,
      liquidityOperation,
      stakeOrLending,
    };
  }
}
