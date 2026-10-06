import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CopyEngine } from "../copy/copy-engine.js";
import { SwapClassifier } from "../decoder/swap-classifier.js";
import { TransactionNormalizer } from "../decoder/transaction-normalizer.js";
import { SystemClock } from "../domain/time.js";
import { ExecutionCoordinator } from "../execution/execution-coordinator.js";
import { startAutomaticExitRecovery } from "../recovery/automatic-exit-scheduler.js";
import { JupiterOrderAdapter } from "../execution/jupiter-order-adapter.js";
import { createIsolatedJupiterFetch } from "../network/isolated-jupiter-fetch.js";
import { PaperTransactionSender } from "../execution/paper-transaction-sender.js";
import { SqliteDatabase } from "../persistence/database.js";
import { StateStore } from "../persistence/state-store.js";
import { LeaderEvidenceStore } from "../persistence/leader-evidence-store.js";
import { ExecutionRealismEvidenceStore } from "../persistence/execution-realism-evidence-store.js";
import { DelayedQuoteSidecar } from "../research/delayed-quote-sidecar.js";
import { parseExecutionRealismDelayPolicy } from "../research/execution-realism-policy.js";
import { RecoveryManager } from "../recovery/recovery-manager.js";
import { SolanaKitRpcProvider } from "../rpc/solana-kit-rpc-provider.js";
import { DualStreamCoordinator } from "../stream/dual-stream-coordinator.js";
import { YellowstoneStreamProvider } from "../stream/yellowstone-stream-provider.js";
import { createLogger } from "../telemetry/logger.js";
import { CaptureArchive } from "../validation/capture-archive.js";
import { LiveEvaluator } from "../validation/evaluator.js";
import { GroundTruthClassifier } from "../validation/ground-truth.js";
import { LiveReportGenerator } from "../validation/report-generator.js";
import { RecoveryValidator } from "../validation/recovery-validator.js";
import { ShadowQuoteRecorder } from "../validation/shadow-quote-recorder.js";
import { SoakMonitor } from "../validation/soak-monitor.js";
import { LiveShadowService } from "../validation/live-shadow-service.js";
import { ValidationStore } from "../validation/validation-store.js";
import { allowedQuoteMints, loadConfig } from "./config.js";
import { drainRuntime } from "./runtime-drain.js";
import { abortable } from "../recovery/abortable.js";
import { RuntimeStopController } from "./runtime-stop.js";
import { boundedRecoveryPolicy } from "../stream/bounded-recovery-policy.js";
import {
  createPrimaryStream,
  QUICKNODE_WEBSOCKET_PROVIDER,
  YELLOWSTONE_PROVIDER,
} from "./stream-provider-factory.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const config = loadConfig();
const riskPolicy = config.riskPolicy;
if (!config.jupiterApiKey) {
  throw new Error(
    "Phase 2 live soak requires JUPITER_API_KEY for GET /swap/v2/order only",
  );
}
const executionRealismPolicy = parseExecutionRealismDelayPolicy(
  readFileSync(
    resolve(root, "config/research/execution-realism-delay-policy-v1.json"),
    "utf8",
  ),
);

const SECONDARY = "secondary-yellowstone";
const secondaryConfigured =
  config.secondaryYellowstoneEndpoint !== undefined &&
  config.secondaryYellowstoneToken !== undefined;
const logger = createLogger(config.logLevel);
const jupiterFetch = createIsolatedJupiterFetch({
  audit: (record) => logger.info(record, "jupiter_network"),
});
const clock = new SystemClock();
const runtimeStop = new RuntimeStopController();
const streamRecoveryPolicy = boundedRecoveryPolicy(
  process.env.V6_STREAM_RECOVERY_POLICY,
);
mkdirSync(dirname(config.databasePath), { recursive: true });
const database = new SqliteDatabase({
  path: config.databasePath,
  migrationsDirectory: resolve(root, "migrations"),
});
const state = new StateStore(database, clock, riskPolicy);
const rpc = new SolanaKitRpcProvider(config.solanaRpcUrl, clock);
const PRIMARY =
  config.streamProvider === "websocket"
    ? QUICKNODE_WEBSOCKET_PROVIDER
    : YELLOWSTONE_PROVIDER;
const validation = new ValidationStore(
  database,
  clock,
  {
    primary: PRIMARY,
    ...(secondaryConfigured ? { secondary: SECONDARY } : {}),
  },
  logger,
);
const primaryStream = createPrimaryStream(config, {
  clock,
  logger,
  checkpoints: state,
  rpc,
  healthObserver: validation,
  ...(streamRecoveryPolicy ? { recoveryPolicy: streamRecoveryPolicy } : {}),
  signal: runtimeStop.signal,
  onRecoveryExhausted: () => runtimeStop.request("STREAM_RECOVERY_EXHAUSTED"),
});
const primary = primaryStream.provider;
const secondary = secondaryConfigured
  ? new YellowstoneStreamProvider({
      providerName: SECONDARY,
      endpoint: config.secondaryYellowstoneEndpoint!,
      token: config.secondaryYellowstoneToken!,
      clock,
      logger,
      checkpoints: state,
      rpc,
      healthObserver: validation,
    })
  : undefined;
const dualStream = new DualStreamCoordinator({
  primary: { name: PRIMARY, provider: primary },
  ...(secondary === undefined
    ? {}
    : { secondary: { name: SECONDARY, provider: secondary } }),
  receipts: validation,
});
const quotes = new ShadowQuoteRecorder(validation);
const jupiter = new JupiterOrderAdapter(
  config.jupiterApiKey,
  jupiterFetch,
  "https://api.jup.ag/swap/v2",
  clock,
);
const sender = new PaperTransactionSender(
  jupiter,
  { results: new Map() },
  quotes,
);
const execution = new ExecutionCoordinator(state, sender);
const leaderEvidenceStore = new LeaderEvidenceStore(database, clock);
const executionRealismSidecar =
  process.env.V6_ONLINE_RESEARCH === "DISABLED"
    ? undefined
    : new DelayedQuoteSidecar(
        jupiter,
        new ExecutionRealismEvidenceStore(database),
        executionRealismPolicy,
        undefined,
        (error, context) =>
          logger.error(
            { error, ...context },
            "execution_realism_sidecar_capture_failed",
          ),
      );
const policies = config.targets.map((target) => ({
  leaderWallet: target.address,
  followerWallet: config.followerWallet,
  copyRatioBps: target.copyRatioBps,
  allowedQuoteMints: allowedQuoteMints(target),
  mode: "SHADOW" as const,
}));
const service = new LiveShadowService(
  dualStream,
  new TransactionNormalizer(clock),
  new SwapClassifier(),
  new GroundTruthClassifier(),
  new CopyEngine(),
  execution,
  state,
  validation,
  new CaptureArchive(config.captureDirectory),
  quotes,
  clock,
  logger,
  PRIMARY,
  policies,
  leaderEvidenceStore,
  executionRealismSidecar,
);
const monitor = new SoakMonitor(database, logger);
const reports = new LiveReportGenerator(
  new LiveEvaluator(database, {
    providerComparisonAvailable: secondaryConfigured,
  }),
  config.reportDirectory,
  { streamProvider: primaryStream.reportLabel },
);
const faultValidator = secondaryConfigured
  ? new RecoveryValidator(dualStream, validation, database, {
      primary: PRIMARY,
      secondary: SECONDARY,
    })
  : undefined;

const faultScenario = process.env.FAULT_INJECTION_SCENARIO;
if (
  (faultScenario === "STREAM_15S_DISCONNECT" ||
    faultScenario === "PRIMARY_DOWN") &&
  !faultValidator
) {
  throw new Error(
    "Yellowstone fault injection requires a passive Secondary Provider",
  );
}

const recovery = await new RecoveryManager(state, sender).recover();
const exitRecovery = startAutomaticExitRecovery(state, sender, () =>
  logger.error("automatic_exit_recovery_failed"),
);
logger.info(
  {
    paperOnly: true,
    targetCount: policies.length,
    recovery,
    durationSeconds: config.soakDurationSeconds,
    providerMode: secondaryConfigured ? "DUAL" : "SINGLE",
    streamProvider: primaryStream.reportLabel,
  },
  "live_shadow_soak_started",
);
const observationStartedAtMs = Date.now();
const observationDeadlineMs =
  observationStartedAtMs + config.soakDurationSeconds * 1000;
logger.info(
  {
    observationStartedAtMs,
    observationDeadlineMs,
    durationSeconds: config.soakDurationSeconds,
  },
  "live_shadow_observation_window_started",
);
service.setIntakeDeadline(observationDeadlineMs);
runtimeStop.setDeadline(observationDeadlineMs);
try {
  await abortable(service.start(), runtimeStop.signal);
  if (!runtimeStop.signal.aborted) monitor.start();
} catch {
  logger.error(
    { stopRequested: runtimeStop.signal.aborted },
    "live_shadow_startup_incomplete",
  );
  runtimeStop.request("STARTUP_FAILED");
}
const providerComparisonTimer = secondaryConfigured
  ? setInterval(() => {
      void validation
        .markMissingProviderEvents(Date.now() - 5_000)
        .catch((error: unknown) =>
          logger.error(
            { error },
            "provider_missing_event_reconciliation_failed",
          ),
        );
    }, 60_000)
  : undefined;
providerComparisonTimer?.unref();
if (
  faultScenario === "STREAM_15S_DISCONNECT" ||
  faultScenario === "PRIMARY_DOWN"
) {
  setTimeout(() => {
    void faultValidator!
      .injectPrimaryOutage(faultScenario)
      .then((result) =>
        logger.info({ result }, "recovery_fault_injection_complete"),
      )
      .catch((error: unknown) =>
        logger.error({ error }, "recovery_fault_injection_failed"),
      );
  }, 5_000).unref();
}

let shutdownStarted = false;

async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (providerComparisonTimer) clearInterval(providerComparisonTimer);
  logger.info(
    {
      signal,
      observationStartedAtMs,
      observationDeadlineMs,
      observationStoppedAtMs: Date.now(),
    },
    "live_shadow_soak_stopping",
  );
  await drainRuntime({
    database,
    timeoutMs: 25_000,
    stages: [
      {
        name: "intake_and_recovery",
        run: async () => {
          const results = await Promise.allSettled([
            service.stop(),
            exitRecovery.stop(),
          ]);
          if (results.some((result) => result.status === "rejected"))
            throw new Error("STOP_FAILED");
        },
      },
      { name: "transport", run: () => jupiterFetch.close() },
      { name: "monitor", run: () => monitor.stop() },
      {
        name: "provider_receipts",
        run: () => validation.markMissingProviderEvents(Date.now() - 5_000),
      },
      { name: "validation", run: () => validation.drain() },
      { name: "writer", run: () => database.writer.onIdle() },
    ],
    counts: () => ({
      queueDepth: service.queueDepth,
      recoveryPending: exitRecovery.pendingCount(),
      transportPending: jupiterFetch.pendingCount() + rpc.pendingCount(),
    }),
    record: (drain) => {
      if (drain.disposition === "INCOMPLETE")
        logger.error(drain, "live_shadow_drain_diagnostics");
      else logger.info(drain, "live_shadow_drain_diagnostics");
      mkdirSync(config.reportDirectory, { recursive: true });
      writeFileSync(
        resolve(config.reportDirectory, "shutdown-drain.json"),
        JSON.stringify(drain, null, 2) + "\n",
        { flush: true },
      );
      if (drain.disposition === "DRAINED")
        logger.info(drain, "live_shadow_drain_complete");
    },
  });
  await reports.generate();
  database.close();
  logger.info(
    { signal, reportDirectory: config.reportDirectory },
    "live_shadow_soak_stopped",
  );
}

try {
  await shutdown(await runtimeStop.wait());
} finally {
  runtimeStop.dispose();
}
