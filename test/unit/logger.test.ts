import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/telemetry/logger.js";

describe("structured logger", () => {
  it("redacts credentials and transaction blobs", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger("debug", destination);
    logger.info(
      {
        apiKey: "should-never-appear",
        privateKey: "should-never-appear",
        seedPhrase: "should-never-appear",
        rawTransaction: "should-never-appear",
      },
      "safe_event",
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(output).toContain("safe_event");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("should-never-appear");
  });
});
