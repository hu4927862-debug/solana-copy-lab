import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedQuoteMints,
  loadConfig,
  loadRiskPolicy,
} from "../../src/app/config.js";
import {
  NATIVE_SOL,
  USDC_MINT,
  USDT_MINT,
  WSOL_MINT,
} from "../../src/domain/assets.js";
import { PROGRAM_IDS } from "../../src/decoder/program-registry.js";
import { FOLLOWER, LEADER_A, LEADER_B } from "../fixtures/mainnet-fixtures.js";

const addresses = [
  LEADER_A,
  LEADER_B,
  PROGRAM_IDS.TOKEN,
  WSOL_MINT,
  USDC_MINT,
  USDT_MINT,
  PROGRAM_IDS.JUPITER_V6,
  PROGRAM_IDS.RAYDIUM_AMM_V4,
  PROGRAM_IDS.PUMP_FUN,
  PROGRAM_IDS.PUMP_SWAP,
];

function environment(targetsPath: string): NodeJS.ProcessEnv {
  const riskPolicyPath = resolve(dirname(targetsPath), "risk-policy.json");
  writeFileSync(
    riskPolicyPath,
    JSON.stringify({
      policyVersion: "PAPER_RISK_V1",
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: "100" },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: "1000" },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: "2000" },
      dailyRealizedLossLimitRawByQuoteMint: { SOL_NATIVE: "500" },
      maxIntentAgeMs: 60_000,
      maxQuoteAgeMs: 5_000,
      maxBuyPriceImpactPctByQuoteMint: { SOL_NATIVE: "1.25" },
      maxSellPriceImpactPctByQuoteMint: { SOL_NATIVE: "2.50" },
      requireRouteEvidence: true,
      provider429BurstThreshold: 3,
      providerBurstWindowMs: 60_000,
      providerCooldownMs: 30_000,
      halfOpenProbe: 1,
    }),
  );
  return {
    DATABASE_PATH: "./var/test.sqlite",
    TARGETS_PATH: targetsPath,
    YELLOWSTONE_ENDPOINT: "https://primary.example.com",
    YELLOWSTONE_X_TOKEN: "primary-token",
    SECONDARY_YELLOWSTONE_ENDPOINT: "https://secondary.example.com",
    SECONDARY_YELLOWSTONE_X_TOKEN: "secondary-token",
    SOLANA_RPC_URL: "https://rpc.example.com",
    SHADOW_FOLLOWER_WALLET: FOLLOWER,
    RISK_POLICY_PATH: riskPolicyPath,
    PAPER_ONLY: "true",
    LIVE_FUNDS_ENABLED: "false",
  };
}

describe("Phase 2 target configuration", () => {
  it("requires a Risk Engine policy path in Paper Mode", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "risk-policy-required-")),
      "targets.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          {
            address: LEADER_A,
            enabled: true,
            copyRatioBps: 1_000,
            allowedQuoteAssets: ["SOL"],
          },
        ],
      }),
    );
    const missing = environment(path);
    delete missing.RISK_POLICY_PATH;
    expect(() => loadConfig(missing)).toThrow();
  });

  it("fails closed on malformed risk policy files", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "risk-policy-invalid-")),
      "risk-policy.json",
    );
    writeFileSync(path, JSON.stringify({ policyVersion: "bad" }));
    expect(() => loadRiskPolicy(path)).toThrow();
  });

  it("canonicalizes SOL and WSOL target assets to one native SOL domain mint", () => {
    expect(
      allowedQuoteMints({
        address: LEADER_A,
        enabled: true,
        copyRatioBps: 1_000,
        allowedQuoteAssets: ["SOL", "WSOL"],
      }),
    ).toEqual([NATIVE_SOL]);
  });

  it("requires LIVE_FUNDS_ENABLED to be exactly false", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "live-funds-disabled-")),
      "targets.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          {
            address: LEADER_A,
            enabled: true,
            copyRatioBps: 1_000,
            allowedQuoteAssets: ["SOL"],
          },
        ],
      }),
    );

    expect(loadConfig(environment(path)).targets).toHaveLength(1);
    for (const value of [undefined, "true", "TRUE", "False", "0"]) {
      const unsafe = environment(path);
      if (value === undefined) delete unsafe.LIVE_FUNDS_ENABLED;
      else unsafe.LIVE_FUNDS_ENABLED = value;
      expect(() => loadConfig(unsafe)).toThrow();
    }
  });

  it("requires PAPER_ONLY to be exactly true", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "paper-only-")),
      "targets.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          {
            address: LEADER_A,
            enabled: true,
            copyRatioBps: 1_000,
            allowedQuoteAssets: ["SOL"],
          },
        ],
      }),
    );

    expect(loadConfig(environment(path)).targets).toHaveLength(1);
    for (const value of [undefined, "false", "TRUE", "True", "1"]) {
      const unsafe = environment(path);
      if (value === undefined) delete unsafe.PAPER_ONLY;
      else unsafe.PAPER_ONLY = value;
      expect(() => loadConfig(unsafe)).toThrow();
    }
  });

  it("accepts at least ten unique dynamic targets", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "targets-")),
      "targets.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        targets: addresses.map((address) => ({
          address,
          enabled: true,
          copyRatioBps: 1_000,
          allowedQuoteAssets: ["SOL", "USDC"],
        })),
      }),
    );
    expect(loadConfig(environment(path)).targets).toHaveLength(10);
  });

  it("rejects secrets and unknown fields in targets.json", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "target-secret-")),
      "targets.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          {
            address: LEADER_A,
            enabled: true,
            copyRatioBps: 1_000,
            allowedQuoteAssets: ["SOL"],
            privateKey: "must-never-be-accepted",
          },
        ],
      }),
    );
    expect(() => loadConfig(environment(path))).toThrow();
  });

  it("accepts Single Provider Mode without secondary credentials", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "single-provider-")),
      "targets.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          {
            address: LEADER_A,
            enabled: true,
            copyRatioBps: 1_000,
            allowedQuoteAssets: ["SOL"],
          },
        ],
      }),
    );
    const singleProvider = environment(path);
    delete singleProvider.SECONDARY_YELLOWSTONE_ENDPOINT;
    delete singleProvider.SECONDARY_YELLOWSTONE_X_TOKEN;
    const config = loadConfig(singleProvider);
    expect(config.secondaryYellowstoneEndpoint).toBeUndefined();
    expect(config.secondaryYellowstoneToken).toBeUndefined();
  });

  it("accepts websocket mode without Yellowstone credentials and derives WSS", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "websocket-provider-")),
      "targets.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          {
            address: LEADER_A,
            enabled: true,
            copyRatioBps: 1_000,
            allowedQuoteAssets: ["SOL"],
          },
        ],
      }),
    );
    const websocket = environment(path);
    websocket.STREAM_PROVIDER = "websocket";
    websocket.SOLANA_RPC_URL =
      "https://example.solana-mainnet.quiknode.pro/redacted-token/";
    delete websocket.YELLOWSTONE_ENDPOINT;
    delete websocket.YELLOWSTONE_X_TOKEN;
    const config = loadConfig(websocket);
    expect(config.streamProvider).toBe("websocket");
    expect(config.solanaWsUrl).toBe(
      "wss://example.solana-mainnet.quiknode.pro/redacted-token/",
    );
    expect(config.yellowstoneEndpoint).toBeUndefined();
    expect(config.yellowstoneToken).toBeUndefined();
  });

  it("requires both primary Yellowstone fields in yellowstone mode", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "yellowstone-required-")),
      "targets.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          {
            address: LEADER_A,
            enabled: true,
            copyRatioBps: 1_000,
            allowedQuoteAssets: ["SOL"],
          },
        ],
      }),
    );
    const yellowstone = environment(path);
    delete yellowstone.YELLOWSTONE_X_TOKEN;
    expect(() => loadConfig(yellowstone)).toThrow(
      /Primary Yellowstone endpoint and token must be configured together/,
    );
  });

  it("rejects a partially configured Secondary Provider", () => {
    const path = resolve(
      mkdtempSync(resolve(tmpdir(), "partial-secondary-")),
      "targets.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          {
            address: LEADER_A,
            enabled: true,
            copyRatioBps: 1_000,
            allowedQuoteAssets: ["SOL"],
          },
        ],
      }),
    );
    const partial = environment(path);
    delete partial.SECONDARY_YELLOWSTONE_X_TOKEN;
    expect(() => loadConfig(partial)).toThrow(
      /endpoint and token must be configured together/,
    );
  });
});
