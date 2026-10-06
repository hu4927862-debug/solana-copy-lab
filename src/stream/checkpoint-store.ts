export interface StreamCheckpointStore {
  saveCheckpoint(
    provider: string,
    subscriptionKey: string,
    slot: bigint,
    signature?: string,
  ): Promise<void>;
  getCheckpoint(
    provider: string,
    subscriptionKey: string,
  ): { slot: bigint; signature?: string } | undefined;
}

/** Durable notifications that have not yet received a business acknowledgement. */
export interface StreamDeliveryStore extends StreamCheckpointStore {
  savePendingDelivery(
    provider: string,
    subscriptionKey: string,
    slot: bigint,
    signature: string,
  ): Promise<void>;
  deletePendingDelivery(
    provider: string,
    subscriptionKey: string,
    signature: string,
  ): Promise<void>;
  listPendingDeliveries(
    provider: string,
    subscriptionKey: string,
  ): readonly { slot: bigint; signature: string }[];
}
