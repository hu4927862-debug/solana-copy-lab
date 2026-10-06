import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "../../src/persistence/database.js";
import { LeaderEvidenceStore } from "../../src/persistence/leader-evidence-store.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { LeaderEvidenceExtractor } from "../../src/research/leader-evidence.js";
import { MAINNET_FIXTURES, LEADER_A } from "../fixtures/mainnet-fixtures.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
import { testStore } from "../helpers/database.js";

function evidence(provider = "primary", feeRaw?: string) {
  const raw = structuredClone(MAINNET_FIXTURES.jupiterBuy);
  if (feeRaw !== undefined) raw.feeRaw = feeRaw;
  const normalized = new TransactionNormalizer(new TestClock()).normalize(
    envelope(raw),
  );
  return new LeaderEvidenceExtractor().extract(
    normalized,
    LEADER_A,
    new SwapClassifier().classify(normalized, LEADER_A),
    provider,
  );
}

describe("LeaderEvidenceStore", () => {
  it("appends exact evidence once and re-reads it after restart", async () => {
    const fixture = testStore("leader-evidence-");
    const clock = new TestClock();
    const store = new LeaderEvidenceStore(fixture.database, clock);
    const item = evidence();
    expect(await store.append(item)).toEqual({
      status: "INSERTED",
      evidenceId: item.evidenceId,
    });
    expect(await store.append(item)).toEqual({
      status: "DUPLICATE",
      evidenceId: item.evidenceId,
    });
    expect(store.read(item.evidenceId)).toEqual(item);
    expect(
      fixture.database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM leader_research_evidence")
        .get(),
    ).toEqual({ count: 1 });
    fixture.database.close();

    const reopened = new SqliteDatabase({
      path: fixture.path,
      migrationsDirectory: new URL("../../migrations", import.meta.url)
        .pathname,
    });
    try {
      expect(
        new LeaderEvidenceStore(reopened, clock).read(item.evidenceId),
      ).toEqual(item);
    } finally {
      reopened.close();
    }
  });

  it("retains conflicting source evidence as another append-only row", async () => {
    const { database } = testStore("leader-evidence-conflict-");
    try {
      const store = new LeaderEvidenceStore(database, new TestClock());
      const first = evidence("primary");
      const conflicting = evidence("secondary", "6000");
      await store.append(first);
      expect(await store.append(conflicting)).toEqual({
        status: "CONFLICT",
        evidenceId: conflicting.evidenceId,
      });
      expect(store.read(conflicting.evidenceId)?.conflictStatus).toBe(
        "CONFLICT",
      );
      expect(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM leader_research_evidence")
          .get(),
      ).toEqual({ count: 2 });
      expect(() =>
        database.sqlite
          .prepare("UPDATE leader_research_evidence SET slot='1'")
          .run(),
      ).toThrow(/APPEND_ONLY/);
      expect(() =>
        database.sqlite.prepare("DELETE FROM leader_research_evidence").run(),
      ).toThrow(/APPEND_ONLY/);
    } finally {
      database.close();
    }
  });

  it("preserves raw values beyond Number safe integer and unavailable nulls", async () => {
    const { database } = testStore("leader-evidence-precision-");
    try {
      const raw = structuredClone(MAINNET_FIXTURES.jupiterBuy);
      raw.preTokenBalances[0]!.rawAmount = "90071992547409931234567890";
      raw.postTokenBalances[0]!.rawAmount = "90071992547409931236567890";
      delete raw.preTokenBalances[0]!.owner;
      delete raw.postTokenBalances[0]!.owner;
      const normalized = new TransactionNormalizer(new TestClock()).normalize(
        envelope(raw),
      );
      const item = new LeaderEvidenceExtractor().extract(
        normalized,
        LEADER_A,
        new SwapClassifier().classify(normalized, LEADER_A),
        "primary",
      );
      const store = new LeaderEvidenceStore(database, new TestClock());
      await store.append(item);
      const reread = store.read(item.evidenceId)!;
      const token = reread.accountBalances.find(
        (balance) => balance.accountIndex === 3,
      )!;
      expect(token.preRaw).toBe("90071992547409931234567890");
      expect(token.ownerStatus).toBe("UNAVAILABLE");
      expect(token.preOwner).toBeNull();
      expect(reread.transactionIndex).toBeNull();
      expect(reread.transactionIndexStatus).toBe("UNAVAILABLE");
    } finally {
      database.close();
    }
  });
});
