export type HydrationFailureReason =
  | "TRANSACTION_NOT_YET_AVAILABLE"
  | "RPC_RATE_LIMITED"
  | "RPC_TIMEOUT"
  | "RPC_HTTP_ERROR"
  | "RPC_JSONRPC_ERROR"
  | "UNSUPPORTED_TRANSACTION_VERSION"
  | "INVALID_RESPONSE"
  | "TRANSACTION_FAILED"
  | "UNKNOWN_HYDRATION_ERROR";

export class RpcHydrationError extends Error {
  constructor(
    readonly reason: Exclude<
      HydrationFailureReason,
      "TRANSACTION_NOT_YET_AVAILABLE" | "UNKNOWN_HYDRATION_ERROR"
    >,
    message: string,
    readonly rpcStatus?: number,
    readonly rpcErrorCode?: number,
  ) {
    super(message);
    this.name = "RpcHydrationError";
  }
}

export function hydrationFailure(error: unknown): {
  readonly reason: Exclude<
    HydrationFailureReason,
    "TRANSACTION_NOT_YET_AVAILABLE"
  >;
  readonly rpcStatus?: number;
  readonly rpcErrorCode?: number;
} {
  if (error instanceof RpcHydrationError)
    return {
      reason: error.reason,
      ...(error.rpcStatus === undefined ? {} : { rpcStatus: error.rpcStatus }),
      ...(error.rpcErrorCode === undefined
        ? {}
        : { rpcErrorCode: error.rpcErrorCode }),
    };
  if (error instanceof DOMException && error.name === "TimeoutError")
    return { reason: "RPC_TIMEOUT" };
  if (
    error instanceof Error &&
    error.message === "RPC_TRANSACTION_FETCH_TIMEOUT"
  )
    return { reason: "RPC_TIMEOUT" };
  return { reason: "UNKNOWN_HYDRATION_ERROR" };
}
