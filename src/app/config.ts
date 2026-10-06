import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { z } from "zod";
import { NATIVE_SOL, USDC_MINT, USDT_MINT } from "../domain/assets.js";
import { parseRiskPolicy } from "../risk/risk-policy.js";
import type { RiskPolicy } from "../risk/risk-engine.js";

const QuoteAssetSchema = z.enum(["SOL", "WSOL", "USDC", "USDT"]);

const SolanaAddressSchema = z.string().refine((value) => {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}, "Expected a 32-byte base58 Solana public address");

const OptionalUrlSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const OptionalNonEmptyStringSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const StreamProviderSchema = z.enum(["websocket", "yellowstone"]);

const TargetSchema = z
  .object({
    address: SolanaAddressSchema,
    enabled: z.boolean().default(true),
    copyRatioBps: z.number().int().min(0).max(100_000),
    allowedQuoteAssets: z.array(QuoteAssetSchema).min(1),
  })
  .strict();

export const TargetsSchema = z
  .object({
    targets: z.array(TargetSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.targets.forEach((target, index) => {
      if (seen.has(target.address)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "address"],
          message: "Duplicate target wallet address",
        });
      }
      seen.add(target.address);
    });
  });

export const EnvironmentSchema = z
  .object({
    DATABASE_PATH: z.string().default("./var/copy-trading.sqlite"),
    TARGETS_PATH: z.string().default("./config/targets.json"),
    STREAM_PROVIDER: StreamProviderSchema.default("yellowstone"),
    YELLOWSTONE_ENDPOINT: OptionalUrlSchema,
    YELLOWSTONE_X_TOKEN: OptionalNonEmptyStringSchema,
    SECONDARY_YELLOWSTONE_ENDPOINT: OptionalUrlSchema,
    SECONDARY_YELLOWSTONE_X_TOKEN: OptionalNonEmptyStringSchema,
    JUPITER_API_KEY: OptionalNonEmptyStringSchema,
    SOLANA_RPC_URL: z.string().url(),
    SOLANA_WS_URL: OptionalUrlSchema,
    SHADOW_FOLLOWER_WALLET: SolanaAddressSchema,
    CAPTURE_DIRECTORY: z.string().default("./var/captures"),
    REPORT_DIRECTORY: z.string().default("./reports"),
    RISK_POLICY_PATH: z.string().min(1),
    SOAK_DURATION_SECONDS: z.coerce.number().int().positive().default(86_400),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PAPER_ONLY: z.literal("true"),
    LIVE_FUNDS_ENABLED: z.literal("false"),
  })
  .strict()
  .passthrough()
  .superRefine((value, context) => {
    const hasPrimaryEndpoint = value.YELLOWSTONE_ENDPOINT !== undefined;
    const hasPrimaryToken = value.YELLOWSTONE_X_TOKEN !== undefined;
    if (hasPrimaryEndpoint !== hasPrimaryToken) {
      context.addIssue({
        code: "custom",
        path: [
          hasPrimaryEndpoint ? "YELLOWSTONE_X_TOKEN" : "YELLOWSTONE_ENDPOINT",
        ],
        message:
          "Primary Yellowstone endpoint and token must be configured together",
      });
    }
    if (value.STREAM_PROVIDER === "yellowstone" && !hasPrimaryEndpoint) {
      context.addIssue({
        code: "custom",
        path: ["YELLOWSTONE_ENDPOINT"],
        message:
          "Yellowstone endpoint and token are required when STREAM_PROVIDER=yellowstone",
      });
    }
    const hasEndpoint = value.SECONDARY_YELLOWSTONE_ENDPOINT !== undefined;
    const hasToken = value.SECONDARY_YELLOWSTONE_X_TOKEN !== undefined;
    if (hasEndpoint !== hasToken) {
      context.addIssue({
        code: "custom",
        path: [
          hasEndpoint
            ? "SECONDARY_YELLOWSTONE_X_TOKEN"
            : "SECONDARY_YELLOWSTONE_ENDPOINT",
        ],
        message:
          "Secondary Yellowstone endpoint and token must be configured together",
      });
    }
  });

export type TargetConfig = z.infer<typeof TargetSchema>;

export const CONFIG_ENVIRONMENT_NAMES = [
  "DATABASE_PATH",
  "TARGETS_PATH",
  "STREAM_PROVIDER",
  "YELLOWSTONE_ENDPOINT",
  "YELLOWSTONE_X_TOKEN",
  "SECONDARY_YELLOWSTONE_ENDPOINT",
  "SECONDARY_YELLOWSTONE_X_TOKEN",
  "JUPITER_API_KEY",
  "SOLANA_RPC_URL",
  "SOLANA_WS_URL",
  "SHADOW_FOLLOWER_WALLET",
  "CAPTURE_DIRECTORY",
  "REPORT_DIRECTORY",
  "RISK_POLICY_PATH",
  "SOAK_DURATION_SECONDS",
  "LOG_LEVEL",
  "PAPER_ONLY",
  "LIVE_FUNDS_ENABLED",
] as const;

export function selectConfigEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    CONFIG_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export interface AppConfig {
  readonly databasePath: string;
  readonly targetsPath: string;
  readonly streamProvider: "websocket" | "yellowstone";
  readonly yellowstoneEndpoint?: string;
  readonly yellowstoneToken?: string;
  readonly secondaryYellowstoneEndpoint?: string;
  readonly secondaryYellowstoneToken?: string;
  readonly jupiterApiKey?: string;
  readonly solanaRpcUrl: string;
  readonly solanaWsUrl: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly followerWallet: string;
  readonly captureDirectory: string;
  readonly reportDirectory: string;
  readonly riskPolicyPath: string;
  readonly riskPolicy: RiskPolicy;
  readonly soakDurationSeconds: number;
  readonly targets: readonly TargetConfig[];
}

export function deriveSolanaWebSocketUrl(rpcUrl: string): string {
  const value = new URL(rpcUrl);
  if (value.protocol === "https:") value.protocol = "wss:";
  else if (value.protocol === "http:") value.protocol = "ws:";
  else throw new Error("SOLANA_RPC_URL must use http or https");
  return value.toString();
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsedEnvironment = EnvironmentSchema.parse(
    selectConfigEnvironment(environment),
  );
  const targets = TargetsSchema.parse(
    JSON.parse(readFileSync(parsedEnvironment.TARGETS_PATH, "utf8")),
  );
  if (
    targets.targets.some(
      (target) => target.address === parsedEnvironment.SHADOW_FOLLOWER_WALLET,
    )
  ) {
    throw new Error("Shadow follower wallet cannot also be a target leader");
  }
  return {
    databasePath: parsedEnvironment.DATABASE_PATH,
    targetsPath: parsedEnvironment.TARGETS_PATH,
    streamProvider: parsedEnvironment.STREAM_PROVIDER,
    ...(parsedEnvironment.YELLOWSTONE_ENDPOINT === undefined
      ? {}
      : { yellowstoneEndpoint: parsedEnvironment.YELLOWSTONE_ENDPOINT }),
    ...(parsedEnvironment.YELLOWSTONE_X_TOKEN === undefined
      ? {}
      : { yellowstoneToken: parsedEnvironment.YELLOWSTONE_X_TOKEN }),
    ...(parsedEnvironment.SECONDARY_YELLOWSTONE_ENDPOINT === undefined
      ? {}
      : {
          secondaryYellowstoneEndpoint:
            parsedEnvironment.SECONDARY_YELLOWSTONE_ENDPOINT,
        }),
    ...(parsedEnvironment.SECONDARY_YELLOWSTONE_X_TOKEN === undefined
      ? {}
      : {
          secondaryYellowstoneToken:
            parsedEnvironment.SECONDARY_YELLOWSTONE_X_TOKEN,
        }),
    ...(parsedEnvironment.JUPITER_API_KEY === undefined
      ? {}
      : { jupiterApiKey: parsedEnvironment.JUPITER_API_KEY }),
    solanaRpcUrl: parsedEnvironment.SOLANA_RPC_URL,
    solanaWsUrl:
      parsedEnvironment.SOLANA_WS_URL ??
      deriveSolanaWebSocketUrl(parsedEnvironment.SOLANA_RPC_URL),
    logLevel: parsedEnvironment.LOG_LEVEL,
    followerWallet: parsedEnvironment.SHADOW_FOLLOWER_WALLET,
    captureDirectory: parsedEnvironment.CAPTURE_DIRECTORY,
    reportDirectory: parsedEnvironment.REPORT_DIRECTORY,
    riskPolicyPath: parsedEnvironment.RISK_POLICY_PATH,
    riskPolicy: loadRiskPolicy(parsedEnvironment.RISK_POLICY_PATH),
    soakDurationSeconds: parsedEnvironment.SOAK_DURATION_SECONDS,
    targets: targets.targets.filter((target) => target.enabled),
  };
}

export function loadRiskPolicy(path: string): RiskPolicy {
  return parseRiskPolicy(JSON.parse(readFileSync(path, "utf8")));
}

const QUOTE_MINTS = {
  SOL: NATIVE_SOL,
  WSOL: NATIVE_SOL,
  USDC: USDC_MINT,
  USDT: USDT_MINT,
} as const;

export function allowedQuoteMints(target: TargetConfig): readonly string[] {
  return [
    ...new Set(target.allowedQuoteAssets.map((asset) => QUOTE_MINTS[asset])),
  ];
}
