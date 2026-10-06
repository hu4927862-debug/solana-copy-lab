import type { StateStore } from "../persistence/state-store.js";
import type { TransactionSender } from "../domain/ports.js";
import {
  AutomaticExitRecovery,
  AUTOMATIC_EXIT_VERSION,
  exitRecoveryEnabled,
} from "./automatic-exit-recovery.js";

/** Opt-in for fresh experiments; persisted opt-in survives process restart. */
export function startAutomaticExitRecovery(
  store: StateStore,
  sender: TransactionSender,
  onError: () => void,
): { stop(): Promise<void>; pendingCount(): number } {
  const requested = process.env.V6_AUTOMATIC_EXIT_RECOVERY;
  if (requested !== undefined && requested !== AUTOMATIC_EXIT_VERSION)
    throw Error("UNKNOWN_EXIT_RECOVERY_POLICY");
  const recovery = new AutomaticExitRecovery(store, sender);
  if (requested) recovery.enableFresh();
  if (!exitRecoveryEnabled(store.database))
    return { stop: async () => {}, pendingCount: () => 0 };
  if (
    process.env.PAPER_ONLY !== "true" ||
    process.env.LIVE_FUNDS_ENABLED !== "false"
  )
    throw Error("PAPER_EXIT_RECOVERY_SAFETY_REQUIRED");
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    active = recovery
      .tick()
      .catch(onError)
      .finally(() => {
        active = undefined;
      });
  }, 1_000);
  return {
    pendingCount: () => recovery.pendingQuoteCount,
    stop: async () => {
      clearInterval(timer);
      const drain = recovery.stop();
      const results = await Promise.allSettled([active, drain]);
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await recovery.stop();
    },
  };
}
