import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileScheduler, type SchedulerEvent } from
  "../src/server/orchestration/scheduler.ts";
import { runScheduledReadOnlyTurn } from
  "../src/server/orchestration/scheduledReadOnlyTurn.ts";

function event(key: string, action: SchedulerEvent["action"]): SchedulerEvent {
  return { key, at: "2026-09-30T00:00:00Z", action };
}
function client(model: string, hold: Promise<void> = Promise.resolve()) {
  let turns = 0;
  return { get turns() { return turns; },
    async initialize() {},
    async discoverModels() { return [{ model, efforts: ["low"], inputModalities: ["text"] }]; },
    async startThread(options: { cwd: string; model: string; sandbox: string }) {
      assert.equal(options.sandbox, "read-only");
      return { threadId: model + "-thread", requestedModel: model,
        resolvedModel: model, modelProvider: "test", rerouted: false };
    },
    async startTurn() { turns++; return model + "-turn"; },
    async waitForTurn(turnId: string) {
      await hold;
      return { turnId, status: "completed" as const, finalText: "READ_ONLY_OK",
        contextInputTokens: null, contextWindow: null, lastUsage: null };
    },
  };
}

test("two independent read-only roles can run within two global slots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-read-slots-"));
  try {
    const one = join(dir, "astra"), two = join(dir, "luna"), out = join(dir, "out");
    await Promise.all([mkdir(one), mkdir(two)]);
    const scheduler = new FileScheduler(join(dir, "scheduler.jsonl"));
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 2, budgetUsd: 0 }));
    for (const [id, role, checkout] of [
      ["a", "astra", one], ["l", "luna", two],
    ] as const) {
      await scheduler.append(event(`submit-${id}`, { type: "submit", work: {
        id, parentId: null, dependencies: [], role, checkout,
        checkoutMode: "read", resources: [], reserveUsd: 0 } }));
    }
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const astra = client("gpt-6-astra", hold);
    const luna = client("gpt-6-luna", hold);
    const run = (workId: string, cwd: string, model: string,
                 selected: ReturnType<typeof client>) => runScheduledReadOnlyTurn({
      scheduler, dispatchKey: `dispatch-${workId}`, workId, client: selected,
      cwd, model, effort: "low", prompt: "Read-only bounded analysis", artifactDir: out,
      timeoutMs: 1000, verify: async (text) => text === "READ_ONLY_OK" });
    const running = Promise.all([run("a", one, "gpt-6-astra", astra),
      run("l", two, "gpt-6-luna", luna)]);
    for (let i = 0; i < 100; i++) {
      const statuses = (await scheduler.read()).state?.entries.map((item) => item.status);
      if (statuses?.every((status) => status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual((await scheduler.read()).state?.entries.map((item) => item.status),
      ["running", "running"]);
    release();
    const results = await running;
    assert.deepEqual(results.map((item) => item.status), ["verified", "verified"]);
    assert.equal(astra.turns, 1);
    assert.equal(luna.turns, 1);
    await assert.rejects(run("l", two, "gpt-6-luna", luna), /claim key already used/);
    assert.equal(luna.turns, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider error leaves the read-only slot for reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-read-error-"));
  try {
    const checkout = join(dir, "luna");
    await mkdir(checkout);
    const scheduler = new FileScheduler(join(dir, "scheduler.jsonl"));
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 1, budgetUsd: 0 }));
    await scheduler.append(event("submit", { type: "submit", work: {
      id: "l", parentId: null, dependencies: [], role: "luna", checkout,
      checkoutMode: "read", resources: [], reserveUsd: 0 } }));
    const selected = { ...client("gpt-6-luna"),
      async waitForTurn() { throw new Error("provider timeout"); } };
    await assert.rejects(runScheduledReadOnlyTurn({ scheduler,
      dispatchKey: "dispatch-l", workId: "l", client: selected,
      cwd: checkout, model: "gpt-6-luna", effort: "low", prompt: "Read-only check",
      artifactDir: join(dir, "out"), timeoutMs: 1000, verify: async () => true }),
    /provider timeout/);
    assert.equal((await scheduler.read()).state?.entries[0].status, "needs_reconciliation");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
