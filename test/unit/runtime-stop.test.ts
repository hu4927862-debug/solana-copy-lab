import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { RuntimeStopController } from "../../src/app/runtime-stop.js";

it("handles SIGTERM during startup and never resets the original deadline or reason", async () => {
  const signals = new EventEmitter();
  const stop = new RuntimeStopController(signals);
  try {
    stop.setDeadline(Date.now() + 1000);
    signals.emit("SIGTERM");
    expect(stop.signal.aborted).toBe(true);
    expect(await stop.wait()).toBe("SIGTERM");
    stop.request("DURATION_COMPLETE");
    expect(await stop.wait()).toBe("SIGTERM");
  } finally {
    stop.dispose();
  }
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});
it("aborts pending startup at the fixed deadline even before startup resolves", async () => {
  const stop = new RuntimeStopController(new EventEmitter());
  try {
    stop.setDeadline(Date.now() + 5);
    expect(await stop.wait()).toBe("DURATION_COMPLETE");
    expect(stop.signal.aborted).toBe(true);
  } finally {
    stop.dispose();
  }
});
