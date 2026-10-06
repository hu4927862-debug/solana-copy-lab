/** Stop waiting and suppress late completion; transports must also receive signal. */
export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () =>
      reject(signal.reason ?? new Error("OPERATION_ABORTED"));
    signal.addEventListener("abort", aborted, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}
