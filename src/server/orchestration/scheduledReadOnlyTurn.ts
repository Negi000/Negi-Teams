// Bounded read-only role work admitted by the shared scheduler.
import { createHash } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CodexAppServerClient, CodexTurnObservation } from
  "../master/appServerClient.ts";
import { FileScheduler, type SchedulerAction } from "./scheduler.ts";

export interface ScheduledReadOnlyTurnOptions {
  scheduler: FileScheduler;
  dispatchKey: string;
  workId: string;
  client: Pick<CodexAppServerClient, "initialize" | "discoverModels" |
    "startThread" | "startTurn" | "waitForTurn">;
  cwd: string;
  model: string;
  effort: string;
  prompt: string;
  artifactDir: string;
  timeoutMs: number;
  verify: (text: string) => Promise<boolean>;
}
export interface ScheduledReadOnlyResult {
  status: "verified" | "failed";
  outputRef: string;
  threadId: string;
  turnId: string;
  observation: CodexTurnObservation;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export async function runScheduledReadOnlyTurn(options: ScheduledReadOnlyTurnOptions):
    Promise<ScheduledReadOnlyResult> {
  const { scheduler, dispatchKey, workId } = options;
  if (!dispatchKey || !workId || !options.model || !options.effort ||
      !options.prompt.trim() || options.prompt.length > 10_000 ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("bounded read-only turn options invalid");
  }
  const cwd = await realpath(resolve(options.cwd));
  const artifactDir = resolve(options.artifactDir);
  await mkdir(artifactDir, { recursive: true });
  const actualArtifactDir = await realpath(artifactDir);
  if (inside(cwd, actualArtifactDir)) throw new Error("read-only artifact output must be outside checkout");
  const entry = (await scheduler.read()).state?.entries.find((candidate) =>
    candidate.work.id === workId);
  if (!entry || !["astra", "sol", "luna"].includes(entry.work.role) ||
      entry.work.checkoutMode !== "read" ||
      entry.work.resources.some((resource) => resource.mode !== "read") ||
      (await realpath(entry.work.checkout)).toLowerCase() !== cwd.toLowerCase()) {
    throw new Error("read-only work does not match scheduler registration");
  }
  await scheduler.claim(workId, dispatchKey);
  const record = (suffix: string, action: SchedulerAction) => scheduler.append({
    key: `${dispatchKey}:${suffix}`, at: new Date().toISOString(), action });
  let threadId: string;
  let turnId: string;
  let observation: CodexTurnObservation;
  try {
    await options.client.initialize();
    const catalog = await options.client.discoverModels();
    if (!catalog.some((item) => item.model === options.model &&
        item.efforts.includes(options.effort) && item.inputModalities.includes("text"))) {
      throw new Error("requested read-only model/effort unavailable");
    }
    const thread = await options.client.startThread({ cwd, model: options.model,
      sandbox: "read-only", instructions: "Work within the prompt. Do not edit files or spawn agents." });
    if (thread.rerouted || thread.resolvedModel !== options.model)
      throw new Error("read-only model rerouted");
    threadId = thread.threadId;
    turnId = await options.client.startTurn(options.prompt, options.effort);
    observation = await options.client.waitForTurn(turnId, options.timeoutMs);
  } catch (error) {
    await record("unknown", { type: "unknown", workId,
      reason: "read-only provider dispatch failed or outcome unknown; inspect provider before release" });
    throw error;
  }
  if (observation.status !== "completed" || !observation.finalText) {
    await record("unknown", { type: "unknown", workId,
      reason: "read-only turn did not provide a completed artifact" });
    throw new Error("read-only turn incomplete; reconciliation required");
  }
  const text = observation.finalText;
  const digest = createHash("sha256").update(text).digest("hex");
  const name = createHash("sha256").update(workId).digest("hex").slice(0, 16);
  const output = join(actualArtifactDir, `${name}-${digest.slice(0, 16)}.md`);
  try {
    const file = await open(output, "wx");
    try { await file.writeFile(text, "utf8"); await file.sync(); }
    finally { await file.close(); }
  } catch (error) {
    await record("unknown", { type: "unknown", workId,
      reason: "read-only artifact persistence failed after provider completion" });
    throw error;
  }
  const outputRef = `${output}#sha256=${digest}`;
  let verified: boolean;
  try { verified = await options.verify(text); }
  catch (error) {
    await record("unknown", { type: "unknown", workId,
      reason: "read-only verification failed without a trustworthy outcome" });
    throw error;
  }
  await record(verified ? "verified" : "failed", { type: "settle", workId,
    outcome: verified ? "verified" : "failed", evidenceRef: outputRef,
    actualCostUsd: null });
  return { status: verified ? "verified" : "failed", outputRef, threadId,
    turnId, observation };
}
