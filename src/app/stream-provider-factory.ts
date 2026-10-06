import type { Logger } from "pino";
import type { RpcProvider, StreamProvider } from "../domain/ports.js";
import type { Clock } from "../domain/time.js";
import type { StreamDeliveryStore } from "../stream/checkpoint-store.js";
import type { StreamHealthObserver } from "../stream/stream-health.js";
import { SolanaWebSocketStreamProvider } from "../stream/solana-websocket-stream-provider.js";
import { YellowstoneStreamProvider } from "../stream/yellowstone-stream-provider.js";
import type { AppConfig } from "./config.js";
import type { BoundedRecoveryPolicy } from "../stream/bounded-recovery-policy.js";

export const QUICKNODE_WEBSOCKET_PROVIDER = "quicknode-websocket";
export const YELLOWSTONE_PROVIDER = "primary-yellowstone";

export interface PrimaryStream {
  readonly name: string;
  readonly reportLabel: "QUICKNODE_WEBSOCKET" | "YELLOWSTONE";
  readonly provider: StreamProvider;
}

export function createPrimaryStream(
  config: AppConfig,
  dependencies: {
    readonly clock: Clock;
    readonly logger: Logger;
    readonly checkpoints: StreamDeliveryStore;
    readonly rpc: RpcProvider;
    readonly healthObserver?: StreamHealthObserver;
    readonly recoveryPolicy?: BoundedRecoveryPolicy;
    readonly signal?: AbortSignal;
    readonly onRecoveryExhausted?: () => void;
  },
): PrimaryStream {
  if (config.streamProvider === "websocket") {
    return {
      name: QUICKNODE_WEBSOCKET_PROVIDER,
      reportLabel: "QUICKNODE_WEBSOCKET",
      provider: new SolanaWebSocketStreamProvider({
        providerName: QUICKNODE_WEBSOCKET_PROVIDER,
        url: config.solanaWsUrl,
        ...dependencies,
      }),
    };
  }
  if (!config.yellowstoneEndpoint || !config.yellowstoneToken)
    throw new Error("Yellowstone configuration is incomplete");
  return {
    name: YELLOWSTONE_PROVIDER,
    reportLabel: "YELLOWSTONE",
    provider: new YellowstoneStreamProvider({
      providerName: YELLOWSTONE_PROVIDER,
      endpoint: config.yellowstoneEndpoint,
      token: config.yellowstoneToken,
      ...dependencies,
    }),
  };
}
