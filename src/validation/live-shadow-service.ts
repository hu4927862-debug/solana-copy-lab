import PQueue from "p-queue";
import type { Logger } from "pino";
import { CopyEngine } from "../copy/copy-engine.js";
import { AssetDeltaEngine } from "../decoder/asset-delta-engine.js";
import { SwapEvidenceValidator } from "../decoder/swap-evidence-validator.js";
import { SwapClassifier } from "../decoder/swap-classifier.js";
import { TransactionNormalizer } from "../decoder/transaction-normalizer.js";
import { stableId } from "../domain/ids.js";
import type { StreamTransactionEnvelope } from "../domain/ports.js";
import type { Clock } from "../domain/time.js";
import { ExecutionCoordinator } from "../execution/execution-coordinator.js";
import { StateStore } from "../persistence/state-store.js";
import { DualStreamCoordinator } from "../stream/dual-stream-coordinator.js";
import { StreamDeliveryDeferredError } from "../stream/delivery-deferred-error.js";
import type { LeaderPolicy } from "../app/copy-trading-service.js";
import { CaptureArchive } from "./capture-archive.js";
import { GroundTruthClassifier } from "./ground-truth.js";
import { ShadowQuoteRecorder } from "./shadow-quote-recorder.js";
import type {
  CapturedEvidence,
  LivePipelineStages,
  ValidationClassification,
  ValidationRecord,
} from "./types.js";
import { ValidationStore } from "./validation-store.js";
import type { LeaderEvidenceSink } from "../persistence/leader-evidence-store.js";
import { LeaderEvidenceExtractor } from "../research/leader-evidence.js";
import type { ExecutionRealismSidecar } from "../research/delayed-quote-sidecar.js";

interface MutableStages {
  streamReceivedMonotonicNs: bigint;
  detectedMonotonicNs?: bigint;
  normalizedMonotonicNs?: bigint;
  classifiedMonotonicNs?: bigint;
  copyIntentCreatedMonotonicNs?: bigint;
  jupiterRequestStartedMonotonicNs?: bigint;
  jupiterResponseReceivedMonotonicNs?: bigint;
  shadowExecutionCompletedMonotonicNs?: bigint;
}

function rejectedClassification(code: string): ValidationClassification {
  if (code === "ORDINARY_TRANSFER") return "TRANSFER";
  if (code === "LIQUIDITY_OPERATION") return "LP";
  if (code === "STAKE_OR_LENDING") return "LENDING";
  if (code === "UNSUPPORTED_TOKEN_2022" || code === "TOKEN_TO_TOKEN")
    return "UNSUPPORTED";
  return "UNKNOWN";
}

export class LiveShadowService {
  private intakeDeadlineMs = Infinity;
  setIntakeDeadline(deadlineMs: number): void {
    this.intakeDeadlineMs = deadlineMs;
  }
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly policies: Map<string, LeaderPolicy>;

  constructor(
    private readonly stream: DualStreamCoordinator,
    private readonly normalizer: TransactionNormalizer,
    private readonly classifier: SwapClassifier,
    private readonly groundTruth: GroundTruthClassifier,
    private readonly copyEngine: CopyEngine,
    private readonly coordinator: ExecutionCoordinator,
    private readonly state: StateStore,
    private readonly validation: ValidationStore,
    private readonly archive: CaptureArchive,
    private readonly quotes: ShadowQuoteRecorder,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly primaryProvider: string,
    policies: readonly LeaderPolicy[],
    private readonly leaderEvidenceStore?: LeaderEvidenceSink,
    private readonly executionRealismSidecar?: ExecutionRealismSidecar,
  ) {
    this.policies = new Map(
      policies.map((policy) => [policy.leaderWallet, policy]),
    );
  }

  async start(): Promise<void> {
    await this.initializeWallets();
    await this.stream.start([...this.policies.keys()], (envelope) => {
      if (Date.now() >= this.intakeDeadlineMs)
        throw new StreamDeliveryDeferredError();
      return this.queue
        .add(() => this.process(envelope))
        .catch((error: unknown) => {
          this.logger.error(
            { error, signature: envelope.signature },
            "live_shadow_pipeline_failed",
          );
          throw error;
        });
    });
  }

  async updatePolicies(policies: readonly LeaderPolicy[]): Promise<void> {
    this.policies.clear();
    for (const policy of policies)
      this.policies.set(policy.leaderWallet, policy);
    await this.initializeWallets();
    await this.stream.updateTargets([...this.policies.keys()]);
  }

  async process(envelope: StreamTransactionEnvelope): Promise<void> {
    let transaction;
    try {
      transaction = this.normalizer.normalize(envelope);
    } catch (error) {
      await this.recordDecodeError(envelope, error);
      return;
    }
    const involved = [...this.policies.values()].filter((policy) =>
      transaction.accountKeys.some(
        (account) => account.address === policy.leaderWallet,
      ),
    );
    for (const policy of involved) {
      const stages: MutableStages = {
        streamReceivedMonotonicNs: envelope.streamReceivedMonotonicNs,
        detectedMonotonicNs: transaction.detectedMonotonicNs,
        normalizedMonotonicNs: transaction.decodedMonotonicNs,
      };
      const classification = this.classifier.classify(
        transaction,
        policy.leaderWallet,
      );
      if (this.leaderEvidenceStore) {
        try {
          const evidence = new LeaderEvidenceExtractor().extract(
            transaction,
            policy.leaderWallet,
            classification,
            this.primaryProvider,
          );
          await this.leaderEvidenceStore.append(evidence);
        } catch (error) {
          this.logger.error(
            { error, signature: transaction.signature },
            "leader_evidence_sidecar_failed",
          );
        }
      }
      stages.classifiedMonotonicNs = this.clock.now().monotonicNs;
      const truth = this.groundTruth.classify(
        transaction,
        policy.leaderWallet,
        classification,
      );
      const deltaResult = new AssetDeltaEngine().calculate(
        transaction,
        policy.leaderWallet,
      );
      const evidenceResult = new SwapEvidenceValidator().validate(transaction);
      const systemClassification: ValidationClassification =
        classification.accepted
          ? classification.event.side
          : rejectedClassification(classification.code);
      const eventIndex = classification.accepted
        ? classification.event.eventIndex
        : 0;
      const validationId = stableId(
        "validation",
        transaction.signature,
        policy.leaderWallet,
        eventIndex,
      );
      const captured: CapturedEvidence = {
        captureVersion: 1,
        capturedAtMs: this.clock.now().wallMs,
        provider: this.primaryProvider,
        leader: policy.leaderWallet,
        transaction: envelope.payload,
        normalized: transaction,
        classification,
        systemClassification,
        groundTruth: truth,
      };
      const capturePath = this.archive.pathFor(captured);
      void this.archive
        .save(captured)
        .catch((error: unknown) =>
          this.logger.error(
            { error, signature: transaction.signature },
            "capture_archive_failed",
          ),
        );
      const event = classification.accepted ? classification.event : undefined;
      const record: ValidationRecord = {
        id: validationId,
        signature: transaction.signature,
        eventIndex,
        slot: transaction.slot,
        ...(transaction.sourceTimestampMs === undefined
          ? {}
          : { blockTimeMs: transaction.sourceTimestampMs }),
        leader: policy.leaderWallet,
        primaryProvider: this.primaryProvider,
        programIds: [
          ...new Set([
            ...transaction.outerInstructions.map(
              (instruction) => instruction.programId,
            ),
            ...transaction.innerInstructions.map(
              (instruction) => instruction.programId,
            ),
          ]),
        ],
        systemClassification,
        groundTruth: truth,
        ...((event?.dex ?? evidenceResult.dex)
          ? { dex: event?.dex ?? evidenceResult.dex }
          : {}),
        ...(event === undefined
          ? {}
          : { tokenMint: event.token.mint, quoteMint: event.quote.mint }),
        balanceDeltas: deltaResult.deltas,
        classifierEvidence: classification.accepted
          ? classification.event.evidence
          : [
              ...evidenceResult.evidence,
              `${classification.code}:${classification.details}`,
            ],
        ...(!classification.accepted
          ? { skipReason: classification.code }
          : {}),
        capturePath,
        isDuplicate: false,
        createdAtMs: this.clock.now().wallMs,
      };
      const firstObservation = await this.validation.saveValidation(record);
      if (!firstObservation) {
        await this.markDuplicate(validationId);
        await this.validation.saveLatency(
          validationId,
          stages as LivePipelineStages,
        );
      }
      if (!event) {
        await this.validation.saveLatency(
          validationId,
          stages as LivePipelineStages,
        );
        continue;
      }
      if (
        policy.allowedQuoteMints &&
        !policy.allowedQuoteMints.includes(event.quote.mint)
      ) {
        await this.setSkipReason(validationId, "QUOTE_ASSET_NOT_ALLOWED");
        await this.validation.saveLatency(
          validationId,
          stages as LivePipelineStages,
        );
        continue;
      }
      await this.state.saveLeaderTrade(event);
      const prior = this.state.followerTradeForSource(
        event.id,
        policy.followerWallet,
      );
      if (prior) {
        if (prior.state === "RESERVED" || prior.state === "PAPER_EXECUTED")
          await this.coordinator.recoverPending();
        await this.markDuplicate(validationId);
        continue;
      }
      const position = this.state.getFollowerPosition(
        policy.followerWallet,
        policy.leaderWallet,
        event.token.mint,
        event.quote.mint,
      );
      const intent = this.copyEngine.decide(event, policy, position);
      stages.copyIntentCreatedMonotonicNs = this.clock.now().monotonicNs;
      this.quotes.register(
        intent.executionKey,
        validationId,
        event,
        this.primaryProvider,
      );
      const result = await this.coordinator.execute(intent);
      const quote = this.quotes.take(intent.executionKey);
      const shadowCompleted = this.clock.now();
      if (quote) {
        stages.jupiterRequestStartedMonotonicNs = quote.requestMonotonicNs;
        if (quote.responseMonotonicNs !== undefined) {
          stages.jupiterResponseReceivedMonotonicNs = quote.responseMonotonicNs;
        }
        if (quote.responseTimestampMs !== undefined) {
          await this.validation.updateQuoteAge(
            intent.executionKey,
            Math.max(0, shadowCompleted.wallMs - quote.responseTimestampMs),
          );
        }
      }
      stages.shadowExecutionCompletedMonotonicNs = shadowCompleted.monotonicNs;
      await this.validation.saveLatency(
        validationId,
        stages as LivePipelineStages,
      );
      if (
        this.executionRealismSidecar &&
        quote?.schemaValid === true &&
        quote.responseTimestampMs !== undefined &&
        quote.expectedOutputRaw !== undefined &&
        quote.inputRaw > 0n &&
        quote.expectedOutputRaw > 0n
      ) {
        try {
          this.executionRealismSidecar.enqueue({
            executionKey: intent.executionKey,
            validationEventId: validationId,
            referenceTimestampMs: quote.responseTimestampMs,
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inputAmountRaw: quote.inputRaw,
            firstQuoteOutputAmountRaw: quote.expectedOutputRaw,
          });
        } catch (error) {
          this.logger.error(
            { error, executionKey: intent.executionKey },
            "execution_realism_sidecar_dispatch_failed",
          );
        }
      }
      this.logger.info(
        {
          signature: event.signature,
          dex: event.dex,
          side: event.side,
          tokenMint: event.token.mint,
          executionKey: intent.executionKey,
          resultState: result?.state ?? "DUPLICATE",
        },
        "live_shadow_copy_processed",
      );
    }
  }

  async stop(): Promise<void> {
    this.intakeDeadlineMs = Math.min(this.intakeDeadlineMs, Date.now());
    await this.stream.close();
    await this.queue.onIdle();
    await this.archive.drain();
    await this.validation.drain();
    if (this.executionRealismSidecar) {
      try {
        await this.executionRealismSidecar.drain();
      } catch (error) {
        this.logger.error({ error }, "execution_realism_sidecar_drain_failed");
      }
    }
  }

  get queueDepth(): number {
    return this.queue.size + this.queue.pending;
  }

  private async initializeWallets(): Promise<void> {
    for (const policy of this.policies.values()) {
      await this.state.upsertWallet(
        policy.leaderWallet,
        "LEADER",
        policy.copyRatioBps,
      );
      await this.state.upsertWallet(policy.followerWallet, "FOLLOWER");
    }
  }

  private async recordDecodeError(
    envelope: StreamTransactionEnvelope,
    error: unknown,
  ): Promise<void> {
    const leader = "UNRESOLVED_TARGET";
    const id = stableId("validation", envelope.signature, leader, 0);
    const truth = {
      classification: "UNKNOWN" as const,
      source: "AUTO_RULE" as const,
      reviewReason: "DECODE_ERROR",
    };
    const captured: CapturedEvidence = {
      captureVersion: 1,
      capturedAtMs: this.clock.now().wallMs,
      provider: this.primaryProvider,
      leader,
      transaction: envelope.payload,
      systemClassification: "UNKNOWN",
      groundTruth: truth,
    };
    const capturePath = this.archive.pathFor(captured);
    void this.archive
      .save(captured)
      .catch((archiveError: unknown) =>
        this.logger.error(
          { error: archiveError, signature: envelope.signature },
          "capture_archive_failed",
        ),
      );
    await this.validation.saveValidation({
      id,
      signature: envelope.signature,
      eventIndex: 0,
      slot: envelope.slot,
      leader,
      primaryProvider: this.primaryProvider,
      programIds: [],
      systemClassification: "UNKNOWN",
      groundTruth: truth,
      balanceDeltas: [],
      classifierEvidence: [],
      skipReason: "PARSER_FAILURE",
      capturePath,
      decodeError: error instanceof Error ? error.message : String(error),
      isDuplicate: false,
      createdAtMs: this.clock.now().wallMs,
    });
    await this.validation.saveLatency(id, {
      streamReceivedMonotonicNs: envelope.streamReceivedMonotonicNs,
      detectedMonotonicNs: this.clock.now().monotonicNs,
    });
  }

  private async markDuplicate(validationId: string): Promise<void> {
    await this.state.database.write(() => {
      this.state.database.sqlite
        .prepare("UPDATE live_validation_events SET is_duplicate=1 WHERE id=?")
        .run(validationId);
    });
  }

  private async setSkipReason(
    validationId: string,
    reason: string,
  ): Promise<void> {
    await this.state.database.write(() => {
      this.state.database.sqlite
        .prepare("UPDATE live_validation_events SET skip_reason=? WHERE id=?")
        .run(reason, validationId);
    });
  }
}
