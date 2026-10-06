import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLLOWER, LEADER_A } from "../fixtures/mainnet-fixtures.js";
import {
  buildCanaryEnvironment,
  providerPreflightValid,
} from "../../src/app/canary-config.js";
const credentials = {
  STREAM_PROVIDER: "websocket",
  SOLANA_RPC_URL: "https://rpc.invalid/key",
  SOLANA_WS_URL: "wss://rpc.invalid/key",
  JUPITER_API_KEY: "SECRET",
  NODE_OPTIONS: "--require /bad",
  HTTPS_PROXY: "http://bad",
  DATABASE_PATH: "/v5/db",
  PAPER_ONLY: "false",
  LIVE_FUNDS_ENABLED: "true",
  YELLOWSTONE_X_TOKEN: "unused",
};
// Synthetic input for the original launch-binding function. No historical
// operator wallet, run approval, provider receipt, or real credential is loaded.
const root = mkdtempSync(join(tmpdir(), "public-canary-fixture-"));
mkdirSync(join(root, "config/research"), { recursive: true });
const targets = [{ address: LEADER_A, enabled: true, copyRatioBps: 1000,
  allowedQuoteAssets: ["SOL", "WSOL", "USDC", "USDT"] }];
writeFileSync(join(root, "config/targets.json"), JSON.stringify({ targets }));
writeFileSync(join(root, "config/research/strategy-a-clean-rerun-protocol-v5.json"),
  JSON.stringify({ strategyBindings: { followerWallet: FOLLOWER, targets } }));
copyFileSync(new URL("../../config/risk-policy.json", import.meta.url),
  join(root, "config/risk-policy.json"));
describe("frozen V6 canary launch environment", () => {
  it("requires only selected WebSocket credentials and excludes inherited runtime overrides", () => {
    const env = buildCanaryEnvironment(credentials, root);
    expect(env).toMatchObject({
      STREAM_PROVIDER: "websocket",
      SOAK_DURATION_SECONDS: "10800",
      PAPER_ONLY: "true",
      LIVE_FUNDS_ENABLED: "false",
      LOG_LEVEL: "info",
    });
    expect(env.DATABASE_PATH).toBe(
      root + "/var/v6-paper-canary-20260908.sqlite",
    );
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.YELLOWSTONE_X_TOKEN).toBeUndefined();
  });
  it("rejects missing selected-provider credentials and provider drift", () => {
    expect(() =>
      buildCanaryEnvironment(
        { ...credentials, SOLANA_WS_URL: "" },
        root,
      ),
    ).toThrow("SOLANA_WS_URL");
    expect(() =>
      buildCanaryEnvironment(
        { ...credentials, STREAM_PROVIDER: "yellowstone" },
        root,
      ),
    ).toThrow("PROVIDER");
  });
});

describe("provider preflight launch evidence", () => {
  const identity = {
    sourceSha256: "src",
    builtSha256: "build",
    configSha256: "config",
    credentialBindingSha256: "creds",
  };
  const now = Date.parse("2026-09-09T00:00:00Z");
  const good = {
    ...identity,
    pass: true,
    attemptId: "current",
    finishedAt: "2026-09-08T23:59:00Z",
  };
  it("accepts only recent completed evidence for the same production identity", () => {
    expect(providerPreflightValid(good, identity, now)).toBe(true);
    for (const patch of [
      { pass: false },
      { finishedAt: "invalid" },
      { finishedAt: "2026-09-09T00:01:00Z" },
      { finishedAt: "2026-09-08T23:00:00Z" },
      { sourceSha256: "old" },
      { builtSha256: "old" },
      { credentialBindingSha256: "old" },
      { attemptId: "" },
    ])
      expect(providerPreflightValid({ ...good, ...patch }, identity, now)).toBe(
        false,
      );
  });
});
