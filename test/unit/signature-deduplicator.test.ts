import { describe, expect, it } from "vitest";
import { SignatureDeduplicator } from "../../src/stream/signature-deduplicator.js";

describe("signature deduplication", () => {
  it("rejects duplicates and evicts only after bounded capacity", () => {
    const dedup = new SignatureDeduplicator(2);
    expect(dedup.accept("a")).toBe(true);
    expect(dedup.accept("a")).toBe(false);
    expect(dedup.accept("b")).toBe(true);
    expect(dedup.accept("c")).toBe(true);
    expect(dedup.accept("a")).toBe(true);
  });
});
