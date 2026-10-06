import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { loadConfig } from "./config.js";

/** Explicit V6 launch bindings; never inherit another runtime's environment. */
export function buildCanaryEnvironment(
  credentials: NodeJS.ProcessEnv,
  root: string,
): NodeJS.ProcessEnv {
  if (credentials.STREAM_PROVIDER !== "websocket")
    throw new Error("CANARY_PROVIDER_DRIFT");
  const protocol = JSON.parse(
    readFileSync(
      resolve(root, "config/research/strategy-a-clean-rerun-protocol-v5.json"),
      "utf8",
    ),
  );
  const targets = JSON.parse(
    readFileSync(resolve(root, "config/targets.json"), "utf8"),
  );
  if (!isDeepStrictEqual(targets.targets, protocol.strategyBindings.targets))
    throw new Error("CANARY_TARGET_DRIFT");
  const risk = readFileSync(resolve(root, "config/risk-policy.json"));
  if (
    createHash("sha256").update(risk).digest("hex") !==
    "7009f133f65c3c2bc75fe91eb93a0bca91caa965eb785189e753e4446ec7126f"
  )
    throw new Error("CANARY_RISK_DRIFT");
  const env: NodeJS.ProcessEnv = {
    STREAM_PROVIDER: "websocket",
    SOAK_DURATION_SECONDS: "10800",
    PAPER_ONLY: "true",
    LIVE_FUNDS_ENABLED: "false",
    LOG_LEVEL: "info",
    TZ: "UTC",
    SHADOW_FOLLOWER_WALLET: protocol.strategyBindings.followerWallet,
    DATABASE_PATH: resolve(root, "var/v6-paper-canary-20260908.sqlite"),
    TARGETS_PATH: resolve(root, "config/targets.json"),
    RISK_POLICY_PATH: resolve(root, "config/risk-policy.json"),
    REPORT_DIRECTORY: resolve(
      root,
      "reports/v6-paper-canary-2026-09-08/runtime",
    ),
    CAPTURE_DIRECTORY: resolve(root, "capture/v6-paper-canary-2026-09-08"),
  };
  for (const key of [
    "JUPITER_API_KEY",
    "SOLANA_RPC_URL",
    "SOLANA_WS_URL",
  ] as const) {
    if (!credentials[key]?.trim())
      throw new Error(`CANARY_CREDENTIAL_MISSING_${key}`);
    env[key] = credentials[key];
  }
  loadConfig(env);
  return env;
}

interface CanaryIdentity {
  readonly sourceSha256: string;
  readonly builtSha256: string;
  readonly configSha256: string;
  readonly credentialBindingSha256: string;
}
/** An old successful probe must never certify a changed or failed latest attempt. */
export function providerPreflightValid(
  evidence: unknown,
  identity: CanaryIdentity,
  now = Date.now(),
): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  const value = evidence as Record<string, unknown>;
  if (
    value.pass !== true ||
    typeof value.attemptId !== "string" ||
    !value.attemptId
  )
    return false;
  const finished =
    typeof value.finishedAt === "string" ? Date.parse(value.finishedAt) : NaN;
  if (
    !Number.isFinite(finished) ||
    finished > now ||
    now - finished > 15 * 60 * 1000
  )
    return false;
  return (
    [
      "sourceSha256",
      "builtSha256",
      "configSha256",
      "credentialBindingSha256",
    ] as const
  ).every((key) => value[key] === identity[key]);
}
