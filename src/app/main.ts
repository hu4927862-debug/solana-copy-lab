import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CopyEngine } from "../copy/copy-engine.js";
import { SwapClassifier } from "../decoder/swap-classifier.js";
import { TransactionNormalizer } from "../decoder/transaction-normalizer.js";
import { SystemClock } from "../domain/time.js";
import { ExecutionCoordinator } from "../execution/execution-coordinator.js";
import { JupiterOrderAdapter } from "../execution/jupiter-order-adapter.js";
import { createIsolatedJupiterFetch } from "../network/isolated-jupiter-fetch.js";
import { PaperTransactionSender } from "../execution/paper-transaction-sender.js";
import { SqliteDatabase } from "../persistence/database.js";
import { StateStore } from "../persistence/state-store.js";
import { LeaderEvidenceStore } from "../persistence/leader-evidence-store.js";
import { RecoveryManager } from "../recovery/recovery-manager.js";
import { startAutomaticExitRecovery } from "../recovery/automatic-exit-scheduler.js";
import { SolanaKitRpcProvider } from "../rpc/solana-kit-rpc-provider.js";
import { createLogger } from "../telemetry/logger.js";
import { allowedQuoteMints, loadConfig } from "./config.js";
import { CopyTradingService } from "./copy-trading-service.js";
import { createPrimaryStream } from "./stream-provider-factory.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const config = loadConfig();
const riskPolicy = config.riskPolicy;
const logger = createLogger(config.logLevel);
const jupiterFetch = createIsolatedJupiterFetch({
  audit: (record) => logger.info(record, "jupiter_network"),
});
const clock = new SystemClock();
mkdirSync(dirname(config.databasePath), { recursive: true });
const database = new SqliteDatabase({
  path: config.databasePath,
  migrationsDirectory: resolve(root, "migrations"),
});
const store = new StateStore(database, clock, riskPolicy);
const leaderEvidenceStore = new LeaderEvidenceStore(database, clock);
const rpc = new SolanaKitRpcProvider(config.solanaRpcUrl, clock);
const stream = createPrimaryStream(config, {
  clock,
  logger,
  checkpoints: store,
  rpc,
}).provider;
const orderProvider = config.jupiterApiKey
  ? new JupiterOrderAdapter(config.jupiterApiKey, jupiterFetch)
  : undefined;
const sender = new PaperTransactionSender(orderProvider);
const coordinator = new ExecutionCoordinator(store, sender);
const service = new CopyTradingService(
  stream,
  new TransactionNormalizer(clock),
  new SwapClassifier(),
  new CopyEngine(),
  coordinator,
  store,
  logger,
  config.targets.map((target) => ({
    leaderWallet: target.address,
    followerWallet: config.followerWallet,
    copyRatioBps: target.copyRatioBps,
    allowedQuoteMints: allowedQuoteMints(target),
    mode: "SHADOW",
  })),
  leaderEvidenceStore,
);

const recovery = await new RecoveryManager(store, sender).recover();
const exitRecovery = startAutomaticExitRecovery(store, sender, () => logger.error("automatic_exit_recovery_failed"));
logger.info(
  { paperOnly: true, recovery, targetCount: config.targets.length },
  "copy_mvp_started",
);
await service.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "graceful_shutdown_started");
  await service.stop();
  await exitRecovery.stop();
  await jupiterFetch.close();
  database.close();
  logger.info({ signal }, "graceful_shutdown_complete");
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
