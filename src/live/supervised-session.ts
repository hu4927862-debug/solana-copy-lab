import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  closeSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { LiveStaging, writeOnce } from "./staging.js";
import { LiveJournal } from "./journal.js";
import { digest, SIGNATURE_SUBMISSION_POLICY } from "./protocol.js";
import type { verifyCandidateIdentity } from "./candidate.js";

type PreparationCommand =
  "activate" | "init" | "prepare" | "signing-request" | "stop-entry";
/** Process seam: sequence existing sealed CLIs, without retries or a send branch. */
export async function prepareSupervisedHandoff(
  side: "BUY" | "SELL",
  run: (command: PreparationCommand, arg?: string) => Promise<any>,
) {
  if (side === "BUY") {
    await run("activate");
    await run("init");
  } else await run("stop-entry");
  const attempt = await run("prepare", side);
  if (attempt.state !== "REVIEWED" || typeof attempt.id !== "string")
    throw Error("SESSION_PREPARE_NOT_REVIEWED");
  return run("signing-request", attempt.id);
}
export function validateSessionReady(plan: any, ready: any, now: number) {
  // Capability negotiation only, NOT advance economic consent. Old pages cannot
  // attest that they render and persist the required per-transaction consent.
  if (
    ready?.consentProtocol !== "EXPLICIT_SINGLE_SUBMIT_CONSENT_V1" ||
    ready.submissionPolicy !== SIGNATURE_SUBMISSION_POLICY ||
    plan.submissionPolicy !== SIGNATURE_SUBMISSION_POLICY
  )
    throw Error("SESSION_WALLET_HANDOFF_INCOMPATIBLE");

  if (
    ready?.version !== "MANUAL_WALLET_READY_V1" ||
    ready.planDigest !== digest(JSON.stringify(plan)) ||
    ready.wallet !== plan.wallet ||
    ready.v0 !== true ||
    !Number.isSafeInteger(ready.atMs) ||
    now < ready.atMs ||
    now - ready.atMs > 120000
  )
    throw Error("SESSION_WALLET_NOT_FRESH_READY");
}
/** Import is responsibility tracking even if intent expired. Only explicit page consent
 * enables the existing deterministic FIRST submit. No retry/rebroadcast command exists. */
export async function completeSupervisedSignature(
  request: any,
  artifact: any,
  run: (
    command: "import-signature" | "submit" | "reconcile",
    attemptId: string,
  ) => Promise<any>,
  now = Date.now,
) {
  if (
    artifact.version !== "LIVE_EXTERNAL_SIGNATURE_V1" ||
    artifact.attemptId !== request.attemptId ||
    artifact.protocolDigest !== request.protocolDigest ||
    artifact.wallet !== request.wallet ||
    artifact.experimentId !== request.experimentId ||
    artifact.messageDigest !== request.review.messageDigest
  )
    throw Error("SESSION_SIGNED_ARTIFACT_BINDING");
  await run("import-signature", request.attemptId);
  if (
    request.submissionPolicy !== SIGNATURE_SUBMISSION_POLICY ||
    artifact.submissionPolicy !== SIGNATURE_SUBMISSION_POLICY ||
    artifact.singleSubmitConsent !== true
  )
    throw Error("SESSION_SINGLE_SUBMIT_CONSENT_REQUIRED");
  if (
    !Number.isSafeInteger(request.expiresAtMs) ||
    now() >= request.expiresAtMs
  )
    throw Error("SESSION_SIGNED_INTENT_EXPIRED_NO_SEND");
  await run("submit", request.attemptId);
  return run("reconcile", request.attemptId);
}
/** File handoff boundary shared by the interactive session and offline async tests.
 * Import verifies and persists signatures; this waiter never signs or constructs a trade. */
export async function waitForSupervisedSignature(
  request: any,
  signed: string,
  run: (
    command: "import-signature" | "submit" | "reconcile",
    attemptId: string,
  ) => Promise<any>,
  now = Date.now,
) {
  if (!Number.isSafeInteger(request.expiresAtMs))
    throw Error("SESSION_REQUEST_DEADLINE_REQUIRED");
  let unreadableArtifact = false;
  for (;;) {
    // Intake precedes the time check: late valid signatures still create durable
    // responsibility, but completeSupervisedSignature must never send late intent.
    if (existsSync(signed)) {
      let artifact: any,
        parsed = false;
      try {
        artifact = JSON.parse(readFileSync(signed, "utf8"));
        parsed = true;
      } catch {
        unreadableArtifact = true;
      }
      if (parsed) {
        const result = await completeSupervisedSignature(
          request,
          artifact,
          run,
          now,
        );
        return { stage: "SINGLE_SUBMIT_RECONCILED", status: result };
      }
    }
    if (now() >= request.expiresAtMs)
      return {
        stage: unreadableArtifact
          ? "UNREADABLE_SIGNED_ARTIFACT_RETAINED"
          : "NO_SIGNATURE_IMPORTED_STOPPED",
        expired: true,
      };
    await new Promise((r) =>
      setTimeout(r, Math.max(1, Math.min(200, request.expiresAtMs - now()))),
    );
  }
}
/** Local interactive session, no keys or signing API. Human Phantom consent authorizes
 * one existing CLI FIRST submit after all checks. Reconciliation is read-only; no loop
 * here can re-sign, retry submission, start another BUY or create another SELL attempt. */
export async function runSupervisedSession(
  root: string,
  candidate: ReturnType<typeof verifyCandidateIdentity>,
  proposalPath: string,
  side: string,
) {
  if (
    !["BUY", "SELL"].includes(side) ||
    candidate.manifest.releaseKind !== "SUPERVISED_CALIBRATION"
  )
    throw Error("SESSION_SCOPE");
  if (!process.stdin.isTTY)
    throw Error("SESSION_INTERACTIVE_OPERATOR_REQUIRED");
  const stage = new LiveStaging(
    root,
    resolve(proposalPath),
    candidate.manifestPath,
  );
  stage.verifyCandidate();
  if (
    candidate.manifest.fundedScope?.signatureSubmissionPolicy !==
      SIGNATURE_SUBMISSION_POLICY ||
    stage.proposal.handoff?.automaticSubmit !== true ||
    stage.proposal.handoff?.signatureSubmissionPolicy !==
      SIGNATURE_SUBMISSION_POLICY
  )
    throw Error("SESSION_SINGLE_SUBMIT_SCOPE_REQUIRED");
  if (!stage.status().approvalRecorded)
    throw Error("SESSION_EXACT_APPROVAL_REQUIRED");
  let expectedInputRaw: string;
  const p = stage.proposal.executionProtocolTemplate,
    run = resolve(root, "var/minimum-live", p.experimentId);
  expectedInputRaw = p.buyLamports;
  if (
    side === "BUY" &&
    (existsSync(stage.activePath) || existsSync(resolve(run, "live.sqlite")))
  )
    throw Error("SESSION_BUY_REQUIRES_NEW_UNACTIVATED_EXPERIMENT");
  if (side === "SELL") {
    stage.assertOwnedWalletClaim();
    const active = stage.readActive();
    const j = new LiveJournal(
      resolve(run, "live.sqlite"),
      active.protocolDigest,
    );
    try {
      const s = j.status();
      if (
        s.obligations.length ||
        BigInt(s.positionRaw) <= 0n ||
        s.takeover ||
        s.attempts.some(
          (a) => a.state === "SETTLED" && !a.data.balanceReconciled,
        )
      )
        throw Error("SESSION_SELL_REQUIRES_FINALIZED_RECONCILED_POSITION");
      expectedInputRaw = s.positionRaw;
    } finally {
      j.close();
    }
  }
  const handoff = resolve(run, `handoff-${side}-${randomUUID()}`);
  mkdirSync(handoff, { recursive: true, mode: 0o700 });
  const plan = {
    version: "MANUAL_LOCAL_HANDOFF_V1",
    submissionPolicy: SIGNATURE_SUBMISSION_POLICY,
    candidateDigest: candidate.candidateDigest,
    proposalDigest: stage.proposalDigest,
    wallet: p.wallet,
    experimentId: p.experimentId,
    side,
    expectedInputRaw,
    nonce: randomUUID(),
    protocolTemplate: p,
  };
  writeOnce(resolve(handoff, "session.json"), plan);
  console.log(
    JSON.stringify(
      {
        handoffDirectory: handoff,
        pairingDigest: digest(JSON.stringify(plan)),
        wallet: p.wallet,
        instruction:
          "In the sealed sign-only page: connect wallet, paste pairingDigest, select this directory and allow read/write. Then return here. T0 has not been started by this command.",
      },
      null,
      2,
    ),
  );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let answer: string;
  try {
    answer = await prompt.question(
      `Type START ${side} only after wallet-ready is displayed: `,
    );
  } finally {
    prompt.close();
  }
  if (answer !== `START ${side}`) throw Error("SESSION_OPERATOR_DID_NOT_START");
  validateSessionReady(
    plan,
    JSON.parse(readFileSync(resolve(handoff, "wallet-ready.json"), "utf8")),
    Date.now(),
  );
  const base = dirname(candidate.manifestPath),
    live = resolve(base, "build/scripts/minimum-live-v2/cli.js"),
    stageCli = resolve(base, "build/scripts/minimum-live-v2/stage-cli.js");
  let sequence = 0;
  async function child(
    command: PreparationCommand | "import-signature" | "submit" | "reconcile",
    arg?: string,
    artifact?: string,
  ) {
    if (
      ![
        "activate",
        "init",
        "prepare",
        "signing-request",
        "stop-entry",
        "import-signature",
        "submit",
        "reconcile",
      ].includes(command)
    )
      throw Error("SESSION_COMMAND_BOUNDARY");
    const cli = command === "activate" ? stageCli : live;
    const args =
      command === "activate"
        ? ["activate", stage.proposalPath, "--activate-after-preflight"]
        : [
            command,
            stage.proposalPath,
            stage.activePath,
            ...(arg ? [arg] : []),
            ...(artifact ? [artifact] : []),
            ...(["init", "signing-request", "submit"].includes(command)
              ? ["--enable-funded-actions"]
              : []),
          ];
    const stem = `${++sequence}-${command}`,
      stdout = resolve(handoff, stem + ".json"),
      stderr = resolve(handoff, stem + ".stderr");
    const o = openSync(stdout, "wx", 0o600),
      e = openSync(stderr, "wx", 0o600);
    let code;
    try {
      code = await new Promise<number | null>((ok, no) => {
        const proc = spawn(process.execPath, [cli, ...args], {
          cwd: root,
          stdio: ["ignore", o, e],
        });
        proc.once("error", no);
        proc.once("exit", ok);
      });
    } finally {
      closeSync(o);
      closeSync(e);
    }
    if (code !== 0) throw Error("SESSION_CHILD_FAILED_REVIEW_HANDOFF_LOGS");
    const text = readFileSync(stdout, "utf8");
    return [
      "activate",
      "prepare",
      "signing-request",
      "submit",
      "reconcile",
    ].includes(command)
      ? JSON.parse(text)
      : { result: text.trim() };
  }
  const exported = await prepareSupervisedHandoff(
    side as "BUY" | "SELL",
    (cmd, arg) =>
      child(cmd, cmd === "stop-entry" ? "SUPERVISED_FINALIZED_FULL_SELL" : arg),
  );
  const request = JSON.parse(readFileSync(exported.path, "utf8"));
  if (
    request.submissionPolicy !== plan.submissionPolicy ||
    request.wallet !== plan.wallet ||
    request.experimentId !== plan.experimentId ||
    request.authorization.candidateDigest !== candidate.candidateDigest
  )
    throw Error("SESSION_REQUEST_BINDING");
  // Transfer the independent CLI binding via clipboard before exposing the request.
  // No signed bytes or secrets are placed on the clipboard.
  const copied =
    process.platform === "darwin" &&
    spawnSync("/usr/bin/pbcopy", [], {
      input: exported.binding,
      encoding: "utf8",
    }).status === 0;
  const temp = resolve(handoff, "request.pending");
  writeOnce(temp, request);
  renameSync(temp, resolve(handoff, "request.json"));
  console.log(
    JSON.stringify(
      {
        stage: "PHANTOM_HANDOFF_READY",
        binding: exported.binding,
        bindingCopied: copied,
        quoteExpiresAtMs: request.expiresAtMs,
        remainingMs: request.expiresAtMs - Date.now(),
        instruction:
          "Request appears automatically. Paste CLI binding, review, check authorization, then click Sign and confirm in Phantom. This authorizes one immediate exact-byte submit after checks; no retries or rebroadcasts.",
      },
      null,
      2,
    ),
  );
  const signed = resolve(handoff, "signed.json");
  const result = await waitForSupervisedSignature(
    request,
    signed,
    (command, id) =>
      child(command, id, command === "import-signature" ? signed : undefined),
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        handoffDirectory: handoff,
        instruction:
          "Retain all exported and late signed artifacts. No retry or automatic recovery. UNKNOWN requires reconciliation; only finalized accounting permits FULL SELL.",
      },
      null,
      2,
    ),
  );
}
