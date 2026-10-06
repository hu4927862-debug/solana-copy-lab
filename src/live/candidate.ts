import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "./protocol.js";

// One local fileset identity; financial eligibility is a separate check.
export function verifyCandidateIdentity(manifestPath: string, expectedDigest?: string) {
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.nlink !== 1) throw Error("LIVE_CANDIDATE_MANIFEST_FILE_TYPE");
  const manifest = realpathSync(manifestPath), base = dirname(manifest);
  const raw = readFileSync(manifest, "utf8"), candidateDigest = digest(raw);
  if (expectedDigest !== undefined && candidateDigest !== expectedDigest)
    throw Error("LIVE_CANDIDATE_DIGEST_MISMATCH");
  const m = JSON.parse(raw);
  if (m.version !== "MANUAL_CANDIDATE_V3" || !m.files || Array.isArray(m.files) ||
      typeof m.files !== "object") throw Error("LIVE_CANDIDATE_MANIFEST_INVALID");
  const actual: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (!stat.isFile() || stat.nlink !== 1) throw Error("LIVE_CANDIDATE_FILE_TYPE");
      else if (path !== manifest) actual.push(relative(base, path).replaceAll("\\", "/"));
    }
  }
  walk(base);
  const keys = Object.keys(m.files).sort();
  if (m.fileCount !== keys.length || JSON.stringify(actual.sort()) !== JSON.stringify(keys))
    throw Error("LIVE_CANDIDATE_FILESET_MISMATCH");
  for (const path of keys) {
    if (isAbsolute(path) || path.split("/").includes("..") ||
        !/^[0-9a-f]{64}$/.test(m.files[path]) ||
        digest(readFileSync(resolve(base, path))) !== m.files[path])
      throw Error("LIVE_CANDIDATE_FILE_MISMATCH");
  }
  for (const path of ["build/scripts/minimum-live-v2/cli.js",
    "build/scripts/minimum-live-v2/stage-cli.js", "build/src/live/candidate.js",
    "build/src/live/unsigned-preflight.js", "build/src/live/transaction-review.js",
    "build/src/live/cpi-semantic-evidence.js", "build/src/live/self-rpc-network.js"])
    if (!m.files[path]) throw Error("LIVE_CANDIDATE_BUILD_MISSING");
  return { manifestPath: manifest, candidateDigest, manifest: m };
}

/** Entrypoint and verifier must both be loaded from this manifest's build.
 * Source-mode launch and mixing one build with another manifest fail closed. */
export function entryCandidate(entryUrl: string) {
  const entry = realpathSync(fileURLToPath(entryUrl));
  const base = resolve(dirname(entry), "../../..");
  const suffix = relative(base, entry).replaceAll("\\", "/");
  if (!["build/scripts/minimum-live-v2/cli.js", "build/scripts/minimum-live-v2/stage-cli.js"].includes(suffix) ||
      realpathSync(fileURLToPath(import.meta.url)) !== join(base, "build/src/live/candidate.js"))
    throw Error("CANDIDATE_ENTRY_NOT_SEALED");
  return verifyCandidateIdentity(join(base, "LIVE_CANDIDATE.json"));
}
