import type { Logger } from "pino";
import PQueue from "p-queue";
import { CopyEngine, type CopyPolicy } from "../copy/copy-engine.js";
import { TransactionNormalizer } from "../decoder/transaction-normalizer.js";
import { SwapClassifier } from "../decoder/swap-classifier.js";
import type {
  StreamProvider,
  StreamSubscription,
  StreamTransactionEnvelope,
} from "../domain/ports.js";
import { ExecutionCoordinator } from "../execution/execution-coordinator.js";
import { StateStore } from "../persistence/state-store.js";
import type { LeaderEvidenceSink } from "../persistence/leader-evidence-store.js";
import { LeaderEvidenceExtractor } from "../research/leader-evidence.js";

export interface LeaderPolicy extends CopyPolicy {
  readonly leaderWallet: string;
  readonly allowedQuoteMints?: readonly string[];
}

export class CopyTradingService {
  private readonly queue = new PQueue({ concurrency: 1 });
  private subscription?: StreamSubscription;
  private readonly policies: Map<string, LeaderPolicy>;

  constructor(
    private readonly stream: StreamProvider,
    private readonly normalizer: TransactionNormalizer,
    private readonly classifier: SwapClassifier,
    private readonly copyEngine: CopyEngine,
    private readonly coordinator: ExecutionCoordinator,
    private readonly store: StateStore,
    private readonly logger: Logger,
    policies: readonly LeaderPolicy[],
    private readonly leaderEvidenceStore?: LeaderEvidenceSink,
  ) {
    this.policies = new Map(
      policies.map((policy) => [policy.leaderWallet, policy]),
    );
  }

  async start(): Promise<void> {
    for (const policy of this.policies.values()) {
      await this.store.upsertWallet(
        policy.leaderWallet,
        "LEADER",
        policy.copyRatioBps,
        policy.maxQuoteRaw,
      );
      await this.store.upsertWallet(policy.followerWallet, "FOLLOWER");
    }
    this.subscription = await this.stream.subscribe(
      [...this.policies.keys()],
      (envelope) => {
        return this.queue
          .add(() => this.process(envelope))
          .catch((error: unknown) => {
            this.logger.error(
              { error, signature: envelope.signature },
              "transaction_pipeline_failed",
            );
            throw error;
          });
      },
    );
  }

  async updatePolicies(policies: readonly LeaderPolicy[]): Promise<void> {
    this.policies.clear();
    for (const policy of policies) {
      this.policies.set(policy.leaderWallet, policy);
      await this.store.upsertWallet(
        policy.leaderWallet,
        "LEADER",
        policy.copyRatioBps,
        policy.maxQuoteRaw,
      );
      await this.store.upsertWallet(policy.followerWallet, "FOLLOWER");
    }
    await this.subscription?.updateTargets([...this.policies.keys()]);
  }

  async stop(): Promise<void> {
    await this.subscription?.close();
    await this.queue.onIdle();
  }

  async process(envelope: StreamTransactionEnvelope): Promise<void> {
    const transaction = this.normalizer.normalize(envelope);
    for (const policy of this.policies.values()) {
      if (
        !transaction.accountKeys.some(
          (account) => account.address === policy.leaderWallet,
        )
      )
        continue;
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
          );
          await this.leaderEvidenceStore.append(evidence);
        } catch (error) {
          this.logger.error(
            { error, signature: transaction.signature },
            "leader_evidence_sidecar_failed",
          );
        }
      }
      if (!classification.accepted) {
        this.logger.debug(
          {
            signature: transaction.signature,
            code: classification.code,
            details: classification.details,
          },
          "transaction_skipped",
        );
        continue;
      }
      const event = classification.event;
      if (
        policy.allowedQuoteMints &&
        !policy.allowedQuoteMints.includes(event.quote.mint)
      ) {
        this.logger.debug(
          { signature: event.signature, quoteMint: event.quote.mint },
          "quote_asset_not_allowed",
        );
        continue;
      }
      await this.store.saveLeaderTrade(event);
      const prior = this.store.followerTradeForSource(
        event.id,
        policy.followerWallet,
      );
      if (prior) {
        if (prior.state === "RESERVED" || prior.state === "PAPER_EXECUTED")
          await this.coordinator.recoverPending();
        this.logger.debug(
          { signature: event.signature, leaderWallet: event.leaderWallet },
          "duplicate_swap_event",
        );
        continue;
      }
      const position = this.store.getFollowerPosition(
        policy.followerWallet,
        policy.leaderWallet,
        event.token.mint,
        event.quote.mint,
      );
      const intent = this.copyEngine.decide(event, policy, position);
      await this.coordinator.execute(intent);
      this.logger.info(
        {
          signature: event.signature,
          dex: event.dex,
          side: event.side,
          tokenMint: event.token.mint,
          quoteMint: event.quote.mint,
          executionKey: intent.executionKey,
          mode: intent.mode,
          skipReason: intent.skipReason,
        },
        "shadow_copy_processed",
      );
    }
  }
}
