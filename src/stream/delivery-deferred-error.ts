/** Intake has closed; the caller must retain the durable delivery for replay. */
export class StreamDeliveryDeferredError extends Error {
  constructor() {
    super("STREAM_DELIVERY_DEFERRED");
    this.name = "StreamDeliveryDeferredError";
  }
}
