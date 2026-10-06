import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDatabase } from "../../src/persistence/database.js";
import { StateStore } from "../../src/persistence/state-store.js";
import type { RiskPolicy } from "../../src/risk/risk-engine.js";
import { USDC_MINT, USDT_MINT } from "../../src/domain/assets.js";
import { TestClock } from "./test-clock.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const TEST_RISK_POLICY: RiskPolicy = {
  policyVersion: "TEST_RISK_V1",
  maxSingleTradeRawByQuoteMint: {
    SOL_NATIVE: 10n ** 30n,
    [USDC_MINT]: 10n ** 30n,
    [USDT_MINT]: 10n ** 30n,
  },
  maxTokenExposureRawByQuoteMint: {
    SOL_NATIVE: 10n ** 30n,
    [USDC_MINT]: 10n ** 30n,
    [USDT_MINT]: 10n ** 30n,
  },
  maxPortfolioExposureRawByQuoteMint: {
    SOL_NATIVE: 10n ** 30n,
    [USDC_MINT]: 10n ** 30n,
    [USDT_MINT]: 10n ** 30n,
  },
  dailyRealizedLossLimitRawByQuoteMint: {
    SOL_NATIVE: 10n ** 30n,
    [USDC_MINT]: 10n ** 30n,
    [USDT_MINT]: 10n ** 30n,
  },
  maxIntentAgeMs: 60_000,
  maxQuoteAgeMs: 5_000,
  maxBuyPriceImpactPctByQuoteMint: {
    SOL_NATIVE: "100",
    [USDC_MINT]: "100",
    [USDT_MINT]: "100",
  },
  maxSellPriceImpactPctByQuoteMint: {
    SOL_NATIVE: "100",
    [USDC_MINT]: "100",
    [USDT_MINT]: "100",
  },
  requireRouteEvidence: true,
  provider429BurstThreshold: 3,
  providerBurstWindowMs: 60_000,
  providerCooldownMs: 30_000,
  halfOpenProbe: 1,
};

export function testStore(
  name = "copy-mvp-",
  riskPolicy: RiskPolicy = TEST_RISK_POLICY,
): {
  database: SqliteDatabase;
  store: StateStore;
  path: string;
} {
  const directory = mkdtempSync(resolve(tmpdir(), name));
  const path = resolve(directory, "test.sqlite");
  const database = new SqliteDatabase({
    path,
    migrationsDirectory: resolve(projectRoot, "migrations"),
  });
  return {
    database,
    store: new StateStore(database, new TestClock(), riskPolicy),
    path,
  };
}
