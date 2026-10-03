import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { loadVaultTaskContract, pathsOutsideScope, runSingleTaskFromVault } from "../src/server/orchestration/vaultTaskContract.ts";

const exporter = fileURLToPath(new URL("../scripts/negi_task_contract.py", import.meta.url));
const baseSha = "b".repeat(40);
test("allowed directory matches whole path components only", () => {
  assert.deepEqual(pathsOutsideScope(["src/server/orchestration/runner.ts",
    "src/server/orchestration-old/other.ts", "README.md"], ["src/server/orchestration"]),
  ["src/server/orchestration-old/other.ts", "README.md"]);
});
function note(id: string, kind: string, body: string, extra = ""): string {
  return `---\nid: ${id}\nkind: ${kind}\nproject: negi\nscope: project\nstatus: active\n` +
    `version: 1\nupdated: 2026-09-29\nsensitivity: local\nsource_refs:\n  - user:fixture\n` +
    `${extra}---\n${body}\n`;
}
function body(sha = baseSha, allowedPaths = ["src/server/orchestration"]): string {
  const value = { objective: "One local parser fix", in_scope: ["Change the parser"],
    out_of_scope: ["No deployment"], allowed_paths: allowedPaths,
    invariants: ["Keep auth unchanged"], acceptance: ["Focused test passes"],
    verification: ["Run focused test"], escalation: ["Stop if schema differs"],
    base_sha: sha, max_attempts: 1, time_limit_minutes: 30 };
  return `# Task\n\n\`\`\`negi-task-contract\n${JSON.stringify(value)}\n\`\`\``;
}

test("exported Vault Task binds source hashes and checkout state before dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-contract-"));
  try {
    const vault = join(dir, "Vault");
    const checkout = join(dir, "checkout");
    await mkdir(join(vault, "10_Projects", "negi"), { recursive: true });
    await mkdir(join(vault, "80_Tasks"), { recursive: true });
    await mkdir(checkout);
    const spec = join(vault, "10_Projects", "negi", "spec.md");
    const task = join(vault, "80_Tasks", "task.md");
    await writeFile(spec, note("SPEC-ONE", "Spec", "Keep auth.", "required: true\n"));
    await writeFile(task, note("TASK-ONE", "Task", body(),
      "depends_on:\n  - SPEC-ONE\napproval_ref: user:fixture\n"));
    const snapshot = join(dir, "contract.json");
    execFileSync("python", [exporter, "--vault", vault, "--id", "TASK-ONE",
      "--project", "negi", "--out", snapshot], { encoding: "utf8", windowsHide: true });
    const good = () => ({ head: baseSha, dirty: false });
    const contract = await loadVaultTaskContract(vault, snapshot, checkout, good);
    assert.equal(contract.vaultId, "TASK-ONE");
    assert.equal(contract.sourceNotes.length, 2);
    assert.deepEqual(contract.scope.allowedPaths, ["src/server/orchestration"]);
    await assert.rejects(loadVaultTaskContract(vault, snapshot, checkout,
      () => ({ head: "c".repeat(40), dirty: false })), /base SHA/);
    await assert.rejects(loadVaultTaskContract(vault, snapshot, checkout,
      () => ({ head: baseSha, dirty: true })), /dirty/);
    const exported = await readFile(snapshot, "utf8");
    const forged = JSON.parse(exported) as Record<string, unknown>;
    forged.objective = "An unrelated task";
    await writeFile(snapshot, JSON.stringify(forged));
    await assert.rejects(loadVaultTaskContract(vault, snapshot, checkout, good), /differs/);
    await writeFile(snapshot, exported);
    const extraSpec = join(vault, "10_Projects", "negi", "new-required.md");
    await writeFile(extraSpec, note("SPEC-NEW", "Spec", "New required rule.", "required: true\n"));
    await assert.rejects(loadVaultTaskContract(vault, snapshot, checkout, good), /differs/);
    await unlink(extraSpec);
    const original = await readFile(task, "utf8");
    await writeFile(task, original + "Human edit.\n");
    await assert.rejects(loadVaultTaskContract(vault, snapshot, checkout, good), /source changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Vault-backed synthetic run blocks a Sol change outside the Task scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-contract-run-"));
  try {
    const repository = fileURLToPath(new URL("..", import.meta.url));
    const checkout = join(dir, "checkout");
    execFileSync("git", ["clone", "--local", "--no-hardlinks", "--quiet", repository, checkout],
      { windowsHide: true });
    const head = execFileSync("git", ["rev-parse", "HEAD"],
      { cwd: checkout, encoding: "utf8", windowsHide: true }).trim();
    const vault = join(dir, "Vault");
    await mkdir(join(vault, "10_Projects", "negi"), { recursive: true });
    await mkdir(join(vault, "80_Tasks"), { recursive: true });
    await writeFile(join(vault, "10_Projects", "negi", "spec.md"),
      note("SPEC-ONE", "Spec", "Keep auth.", "required: true\n"));
    await mkdir(join(vault, "40_Lessons"));
    await writeFile(join(vault, "40_Lessons", "sol.md"),
      note("LESSON-SOL", "Lesson", "Long implementation detail.",
        "title: parser guidance\nsummary: Sol parser detail\nroles:\n  - sol\n"));
    await writeFile(join(vault, "80_Tasks", "task.md"),
      note("TASK-ONE", "Task", body(head, ["README.md"]),
        "depends_on:\n  - SPEC-ONE\napproval_ref: user:fixture\n"));
    const snapshot = join(dir, "contract.json");
    execFileSync("python", [exporter, "--vault", vault, "--id", "TASK-ONE",
      "--project", "negi", "--out", snapshot], { encoding: "utf8", windowsHide: true });
    await assert.rejects(loadVaultTaskContract(vault, snapshot, join(checkout, "src")), /checkout root/);
    let verified = false;
    const prompts: Record<string, string[]> = {};
    function fake(model: string, answer: string, onTurn?: () => Promise<void>) {
      return {
        initialize: async () => {},
        discoverModels: async () => [{ model, efforts: ["medium"], inputModalities: ["text"] }],
        startThread: async () => ({ threadId: `thread-${model}`, requestedModel: model,
          resolvedModel: model, modelProvider: "mock", rerouted: false }),
        startTurn: async (text: string) => {
          (prompts[model] ??= []).push(text);
          await onTurn?.();
          return `turn-${model}`;
        },
        waitForTurn: async (turnId: string) => ({ turnId, status: "completed" as const,
          finalText: answer, contextInputTokens: null, contextWindow: null, lastUsage: null }),
      };
    }
    const solWrite = async () => {
      const packageFile = join(checkout, "package.json");
      await writeFile(packageFile, (await readFile(packageFile, "utf8")) + "\n");
    };
    const scopeOptions = { runId: "run-scope", vaultDirectory: vault,
      contextCacheDirectory: join(dir, "context-cache"),
      snapshotPath: snapshot, cwd: checkout,
      astra: { client: fake("gpt-6-astra", "Plan one change"), model: "gpt-6-astra", effort: "medium" },
      sol: { client: fake("gpt-6-sol", "Work finished", solWrite), model: "gpt-6-sol", effort: "medium" },
      ledger: new FileTaskLedger(join(dir, "run.jsonl")), artifactDir: join(dir, "artifacts"),
      turnTimeoutMs: 1000,
      verify: async () => { verified = true; return { outcome: "passed" as const, evidenceRef: "mock:passed" }; },
    } satisfies Parameters<typeof runSingleTaskFromVault>[0];
    for (const cache of [vault, join(vault, "cache"), checkout, join(checkout, "cache"), dir]) {
      await assert.rejects(runSingleTaskFromVault({ ...scopeOptions, contextCacheDirectory: cache }),
        /Context cache must be separate/);
    }
    assert.deepEqual(prompts, {});
    const state = await runSingleTaskFromVault(scopeOptions);
    assert.equal(state.status, "blocked");
    assert.equal(verified, false);
    assert.match(state.verification?.evidenceRef ?? "", /package\.json/);
    assert.equal(state.acceptedBy, null);
    const allowedCheckout = join(dir, "checkout-allowed");
    execFileSync("git", ["clone", "--local", "--no-hardlinks", "--quiet", repository, allowedCheckout],
      { windowsHide: true });
    const allowedWrite = async () => {
      const readme = join(allowedCheckout, "README.md");
      await writeFile(readme, (await readFile(readme, "utf8")) + "\nLocal fixture change.\n");
    };
    const allowedState = await runSingleTaskFromVault({ runId: "run-allowed", vaultDirectory: vault,
      contextCacheDirectory: join(dir, "context-cache"),
      snapshotPath: snapshot, cwd: allowedCheckout,
      astra: { client: fake("gpt-6-astra", "Plan one change"), model: "gpt-6-astra", effort: "medium" },
      sol: { client: fake("gpt-6-sol", "Work finished", allowedWrite), model: "gpt-6-sol", effort: "medium" },
      ledger: new FileTaskLedger(join(dir, "allowed-run.jsonl")), artifactDir: join(dir, "allowed-artifacts"),
      turnTimeoutMs: 1000,
      verify: async () => { verified = true; return { outcome: "passed" as const, evidenceRef: "mock:passed" }; },
    });
    assert.equal(allowedState.status, "ready_for_review");
    assert.equal(verified, true);
    assert.equal(allowedState.acceptedBy, null);
    assert.match(prompts["gpt-6-astra"][1], /Keep auth\./);
    assert.match(prompts["gpt-6-astra"][1], /TASK-ONE/);
    assert.doesNotMatch(prompts["gpt-6-astra"][1], /Sol parser detail/);
    assert.match(prompts["gpt-6-sol"][1], /Sol parser detail/);
    assert.match(prompts["gpt-6-sol"][1], /Plan one change/);
    const packRefs = allowedState.contract.contextPacks!;
    for (const role of ["astra", "sol"] as const) {
      const pack = await readFile(packRefs[role].path);
      assert.equal(createHash("sha256").update(pack).digest("hex"), packRefs[role].sha256);
      assert.match(pack.toString("utf8"), new RegExp(`role=${role}`));
    }
    const changedCheckout = join(dir, "checkout-changed-context");
    execFileSync("git", ["clone", "--local", "--no-hardlinks", "--quiet", repository, changedCheckout],
      { windowsHide: true });
    const changeLesson = async () => {
      const lesson = join(vault, "40_Lessons", "sol.md");
      await writeFile(lesson, (await readFile(lesson, "utf8"))
        .replace("Sol parser detail", "Sol parser detail changed"));
    };
    const solPromptCount = prompts["gpt-6-sol"].length;
    const changedState = await runSingleTaskFromVault({ runId: "run-changed-context", vaultDirectory: vault,
      contextCacheDirectory: join(dir, "context-cache"),
      snapshotPath: snapshot, cwd: changedCheckout,
      astra: { client: fake("gpt-6-astra", "Plan one change", changeLesson),
        model: "gpt-6-astra", effort: "medium" },
      sol: { client: fake("gpt-6-sol", "unused"), model: "gpt-6-sol", effort: "medium" },
      ledger: new FileTaskLedger(join(dir, "changed-run.jsonl")),
      artifactDir: join(dir, "changed-artifacts"), turnTimeoutMs: 1000,
      verify: async () => { throw new Error("verification must not run"); },
    });
    assert.equal(changedState.status, "stopped");
    assert.equal(prompts["gpt-6-sol"].length, solPromptCount);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
