/** Evidence protocol for an explicitly approved future window; legacy stays strict. */
export function createRecoveryMonitor(policy, now = () => performance.now()) {
  if (
    policy.version !== "BOUNDED_REPLAY_V1" ||
    !policy.provider ||
    !policy.subscriptionKey ||
    !Number.isSafeInteger(policy.targetCount) ||
    policy.targetCount < 1 ||
    !["maxEpisodeMs", "maxEpisodes", "maxTotalRecoveryMs"].every(
      (k) => Number.isSafeInteger(policy[k]) && policy[k] > 0,
    )
  )
    throw Error("INVALID_RECOVERY_SUPERVISION_POLICY");
  const created = now();
  let generation = -1,
    state = "UNKNOWN",
    subscriptionKey,
    episodeStart,
    episodes = 0,
    totalMs = 0,
    ready = false,
    failure;
  const fail = (reason) => (failure ??= reason);
  const check = () => {
    const at = now();
    if (state === "UNKNOWN" && at - created >= policy.maxEpisodeMs)
      fail("RECOVERY_PROTOCOL_MISSING");
    if (episodeStart !== undefined && at - episodeStart >= policy.maxEpisodeMs)
      fail("RECOVERY_EPISODE_DEADLINE");
    if (
      totalMs + (episodeStart === undefined ? 0 : at - episodeStart) >=
      policy.maxTotalRecoveryMs
    )
      fail("RECOVERY_TOTAL_BUDGET");
    return failure;
  };
  const observe = (e) => {
    if (e.msg !== "websocket_recovery_state") return check();
    if (
      e.policyVersion !== policy.version ||
      e.provider !== policy.provider ||
      !Number.isSafeInteger(e.generation) ||
      e.generation < 0 ||
      typeof e.subscriptionKey !== "string" ||
      !e.subscriptionKey
    )
      return fail("RECOVERY_PROTOCOL_INVALID");
    if (
      e.subscriptionKey !== policy.subscriptionKey ||
      (subscriptionKey !== undefined && subscriptionKey !== e.subscriptionKey)
    )
      return fail("RECOVERY_TARGET_IDENTITY_CHANGED");
    subscriptionKey = e.subscriptionKey;
    if (e.generation < generation) return check(); // Old completion cannot clear current HOLD.
    if (e.generation > generation && e.state !== "HOLD")
      return fail("RECOVERY_GENERATION_WITHOUT_HOLD");
    generation = e.generation;
    if (e.state === "HOLD") {
      if (e.reason === "STREAM_CHECKPOINT_WRITE_FAILED")
        return fail("RECOVERY_EVIDENCE_WRITE_FAILED");
      if (episodeStart === undefined) {
        episodeStart = now();
        episodes++;
      }
      ready = false;
      if (episodes > policy.maxEpisodes)
        return fail("RECOVERY_EPISODES_EXHAUSTED");
    } else if (e.state === "READY") {
      if (
        state !== "DRAINING" ||
        !e.scanComplete ||
        !e.checkpointCommitted ||
        e.targetCount !== policy.targetCount ||
        ![e.replayFromSlot, e.replayThroughSlot, e.checkpointSlot].every(
          (s) => typeof s === "string" && /^\d+$/.test(s),
        ) ||
        BigInt(e.replayThroughSlot) < BigInt(e.replayFromSlot) ||
        e.subscriptionsAcknowledged !== e.targetCount ||
        ![e.buffered, e.unpersisted, e.pendingDeliveries].every((n) => n === 0)
      )
        return fail("RECOVERY_PROOF_INCOMPLETE");
      if (check()) return failure;
      totalMs += now() - episodeStart;
      episodeStart = undefined;
      ready = true;
    } else if (e.state === "STOPPED") {
      // A successful drain of queues alone cannot hide an unresolved source gap.
      ready = ready && e.recoveryComplete === true;
    } else if (e.state === "FAILED") return fail("RECOVERY_PROVIDER_EXHAUSTED");
    else if (!(
      (e.state === "SUBSCRIBING" && state === "HOLD") ||
      (e.state === "REPLAYING" && state === "SUBSCRIBING") ||
      (e.state === "DRAINING" && ["REPLAYING", "DRAINING"].includes(state))
    ))
      return fail("RECOVERY_STATE_TRANSITION_INVALID");
    state = e.state;
    return check();
  };
  return {
    observe,
    check,
    tolerates(e) {
      if (
        failure ||
        episodeStart === undefined ||
        e.provider !== policy.provider
      )
        return false;
      if (
        [
          "websocket_reconnect_scheduled",
          "websocket_gap_recovery_failed",
        ].includes(e.msg)
      )
        return true;
      return (
        e.msg === "websocket_stream_degraded" &&
        [
          "HOST_SCHEDULING_GAP",
          "TRANSACTION_NOT_YET_AVAILABLE",
          "RPC_TIMEOUT",
          "RPC_HTTP_ERROR",
          "RPC_JSONRPC_ERROR",
          "RPC_TRANSPORT_ERROR",
          "RPC_NETWORK_ERROR",
        ].includes(e.reason)
      );
    },
    snapshot: () => ({
      policy,
      generation,
      state,
      subscriptionKey,
      episodes,
      totalRecoveryMs:
        totalMs + (episodeStart === undefined ? 0 : now() - episodeStart),
      unresolved: !ready,
      failure: failure ?? null,
    }),
    recovered: () => ready && !failure && episodeStart === undefined,
  };
}
