import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import bs58 from "bs58";
import { digest } from "./protocol.js";
import type { AccountBatch, RawAccount } from "./cpi-semantic-evidence.js";
export const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";
export const PROGRAM_PINS = [
  {
    program: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    programData: "4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT",
    space: 2892269,
    sha256: "a2a018f56440b193568ee224e565ddb3f724b181c8e16bbe59f8a3eb5bdc9b7f",
  },
  {
    program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    programData: "HzD2cCXXT3UQNjMMY6kDv9w6gZ9qquSdfoGXrLL3LXx",
    space: 1700205,
    sha256: "b3e4706f5fff2399862cb91c9ac07924d1ea8695c686dbe711938db944836ee1",
  },
] as const;
/** Current CLMM successor, not a rewrite of the historical trust anchor. Current full
 * finalized bytes and immutable official-source contract review are preserved in
 * reports/jupiter-wallet-selection-20260930/current-clmm/. Source/binary build
 * equivalence remains the same explicitly unproved limitation as the parent. */
export const CURRENT_CLMM_PROGRAM_PINS = [
  PROGRAM_PINS[0],
  { ...PROGRAM_PINS[1], sha256: "30cd64bbdeea321209db0fb9cdab3e52903f42dfbdc3e4c05306a9404cbc3c00" },
] as const;
// The completed function test and source-derived classic follower use the same
// independently captured deployment. Keep its original public name/identity.
export const FUNCTION_TEST_PROGRAM_PINS = CURRENT_CLMM_PROGRAM_PINS;
/** Explicit successor capture for the unchanged single direct CLMM contract.
 * This does not replace Sep30 or authorize a runtime. Narrow nonfunded contract
 * revalidation and its limitations are recorded with the independent capture. */
export const JUPITER_CLMM_20261002_PROGRAM_PINS = [
  { ...PROGRAM_PINS[0], sha256: "2fae6c67dbb46871dbc273ced109117a3f7c185b2af8364cfe27b3902ebab8e1" },
  CURRENT_CLMM_PROGRAM_PINS[1],
] as const;
export type ClmmProgramAttestationReference = "JUPITER_CLMM_20261002_V1";
/** Separate finalized capture. Old CLMM and Manual anchors remain unchanged.
 * Binary/source equivalence is not asserted by this hash/metadata proof. */
export const DLMM_PROGRAM_PINS = [
  {...PROGRAM_PINS[0],sha256:"2fae6c67dbb46871dbc273ced109117a3f7c185b2af8364cfe27b3902ebab8e1"},
  {program:"LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",programData:"HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu",
    space:2229821,sha256:"33d30765256dba41781f651a7596e7e6e6d475f4299937dadf5e8f7c34a2fb08"},
] as const;
export const DLMM_PROGRAM_METADATA_KEYS = [...DLMM_PROGRAM_PINS.map(p=>p.program),...DLMM_PROGRAM_PINS.map(p=>p.programData)];
export type AttestationPurpose = "EXECUTION_FUNCTION_TEST";
type ProgramPins = readonly { program: string; programData: string; space: number; sha256: string }[];
export const PROGRAM_METADATA_KEYS = [
  ...PROGRAM_PINS.map((p) => p.program),
  ...PROGRAM_PINS.map((p) => p.programData),
];
export interface ProgramAttestation {
  digest: string;
  slot: number;
  headers: string[];
}
export interface ProgramProof {
  attestationDigest: string;
  slot: number;
  batch: AccountBatch;
}
function check(ok: unknown, code = "PROGRAM_ATTESTATION_STALE"): asserts ok {
  if (!ok) throw Error(code);
}
function bytes(
  a: RawAccount | null | undefined,
  executable: boolean,
  space: number,
  length: number,
) {
  check(
    a &&
      a.owner === LOADER_V3 &&
      a.executable === executable &&
      a.space === space &&
      a.data?.[1] === "base64" &&
      a.data.length === 2 &&
      /^(?:[1-9]\d*)$/.test(String(a.lamports)),
  );
  const b = Buffer.from(a!.data[0], "base64");
  check(b.length === length && b.toString("base64") === a!.data[0]);
  return b;
}
function slot(n: unknown): number {
  check(Number.isSafeInteger(n) && Number(n) > 0);
  return Number(n);
}
/** Validate full bytes locally before any quote clock. The sealed capture's request
 * proves finalized provenance; no caller-supplied cache or metadata is trusted. */
export function validateFullAttestation(raw: any, pins: ProgramPins = PROGRAM_PINS): ProgramAttestation {
  check(
    raw?.version === "FINALIZED_PROGRAM_ATTESTATION_V1" &&
      raw.commitment === "finalized",
    "PROGRAM_ATTESTATION_MISSING",
  );
  const p = raw.programs as AccountBatch,
    d = raw.programData as AccountBatch;
  check(
    p &&
      d &&
      JSON.stringify(p.keys) ===
        JSON.stringify(pins.map((x) => x.program)) &&
      JSON.stringify(d.keys) ===
        JSON.stringify(pins.map((x) => x.programData)) &&
      p.values.length === 2 &&
      d.values.length === 2,
  );
  check(raw.provenance?.request?.params?.[1]?.commitment === "finalized" &&
    JSON.stringify(raw.provenance.request.params[0]) === JSON.stringify(d.keys), "PROGRAM_ATTESTATION_MISSING");
  const s = slot(d.slot);
  check(s >= slot(p.slot));
  const headers = pins.map((pin, i) => {
    const pb = bytes(p.values[i], true, 36, 36),
      db = bytes(d.values[i], false, pin.space, pin.space);
    check(
      pb.readUInt32LE(0) === 2 &&
        bs58.encode(pb.subarray(4)) === pin.programData,
    );
    check(
      db.readUInt32LE(0) === 3 &&
        (db[12] === 0 || db[12] === 1) &&
        db.readBigUInt64LE(4) <= BigInt(s),
    );
    check(digest(db) === pin.sha256, "PROGRAM_ATTESTATION_HASH_MISMATCH");
    return db.subarray(0, 45).toString("base64");
  });
  return {
    digest: digest(
      JSON.stringify({
        version: raw.version,
        slot: s,
        headers,
        pins,
      }),
    ),
    slot: s,
    headers,
  };
}
let sealed: ProgramAttestation | undefined;
let currentClmmSealed: ProgramAttestation | undefined;
let octoberClmmSealed: ProgramAttestation | undefined;
let dlmmSealed: ProgramAttestation | undefined;
export function sealedDlmmProgramAttestation():ProgramAttestation{
  if(!dlmmSealed)dlmmSealed=validateFullAttestation(JSON.parse(gunzipSync(readFileSync(
    new URL("./program-attestation.dlmm-20261001.full.json.gz",import.meta.url))).toString()),DLMM_PROGRAM_PINS);
  return structuredClone(dlmmSealed);
}
/** Explicit current deployment selection; validating the full existing capture
 * is still mandatory. Historical Manual callers retain their original default. */
export function sealedCurrentClmmProgramAttestation(reference?: ClmmProgramAttestationReference): ProgramAttestation {
  if (reference !== undefined) {
    check(reference === "JUPITER_CLMM_20261002_V1", "PROGRAM_ATTESTATION_REFERENCE_UNSUPPORTED");
    if (!octoberClmmSealed) octoberClmmSealed = validateFullAttestation(
      JSON.parse(gunzipSync(readFileSync(new URL("./program-attestation.jupiter-clmm-20261002.full.json.gz", import.meta.url))).toString()),
      JUPITER_CLMM_20261002_PROGRAM_PINS,
    );
    return structuredClone(octoberClmmSealed);
  }
  if (!currentClmmSealed) currentClmmSealed = validateFullAttestation(
    JSON.parse(gunzipSync(readFileSync(new URL("./program-attestation.function-test-20260930.full.json.gz", import.meta.url))).toString()),
    CURRENT_CLMM_PROGRAM_PINS,
  );
  return structuredClone(currentClmmSealed);
}
export function sealedProgramAttestation(purpose?: AttestationPurpose): ProgramAttestation {
  if (purpose === "EXECUTION_FUNCTION_TEST") {
    return sealedCurrentClmmProgramAttestation();
  }
  if (!sealed)
    sealed = validateFullAttestation(
      JSON.parse(
        gunzipSync(
          readFileSync(
            new URL("./program-attestation.full.json.gz", import.meta.url),
          ),
        ).toString(),
      ),
    );
  return structuredClone(sealed);
}
/** 36+36+45+45 account data bytes; RPC space must be full account space, not slice size.
 * Exact 45-byte comparison also covers unused option bytes, preserving full hash identity. */
export function validateProgramMetadata(
  a: ProgramAttestation,
  f: AccountBatch,
  required: number,
  pins: ProgramPins = PROGRAM_PINS,
): ProgramProof {
  check(a && typeof a.digest === "string" && a.headers?.length === 2);
  check(
    slot(f?.slot) >= Math.max(slot(required), slot(a.slot)) &&
      JSON.stringify(f.keys) === JSON.stringify([...pins.map(p=>p.program),...pins.map(p=>p.programData)]) &&
      f.values.length === 4,
  );
  pins.forEach((pin, i) => {
    const pb = bytes(f.values[i], true, 36, 36),
      db = bytes(f.values[i + 2], false, pin.space, 45);
    check(
      pb.readUInt32LE(0) === 2 &&
        bs58.encode(pb.subarray(4)) === pin.programData,
    );
    check(db.readUInt32LE(0) === 3 && db.toString("base64") === a.headers[i]);
  });
  return {
    attestationDigest: a.digest,
    slot: f.slot,
    batch: structuredClone(f),
  };
}
