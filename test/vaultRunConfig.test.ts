import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertVaultRunOutputPaths, assertVerificationCoverage, assertVaultWorkerContract, vaultWorker,
  parseVaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";

const root = process.platform === "win32" ? "E:\\Negi-Teams\\" : "/tmp/";
const base = { executable: `${root}codex`, checkout: `${root}checkout`,
  vault: `${root}vault`, snapshot: `${root}task.json`, outputDir: `${root}output`,
  schedulerPath: `${root}scheduler.jsonl`, runId: "task-1",
  astra: { model: "gpt-6-astra", effort: "low" },
  sol: { model: "gpt-6.1-sol", effort: "low" },
  verification: [{ requirement: "Node version is known", program: "node",
    args: ["--version"], timeoutMs: 5000 }],
  resources: ["source-map"] };

test("explicit Vault run config preserves command argv without invoking a shell", () => {
  assert.deepEqual(parseVaultRunConfig(base), base);
});
test("research registration is explicit and contains no legacy Sol write profile",()=>{
  const {sol,...common}=base;
  const raw={...common,taskMode:"read_only_research",luna:{model:"gpt-6-luna",effort:"low"}};
  const parsed=parseVaultRunConfig(raw);
  assert.deepEqual(parsed,raw);assert.equal("sol" in parsed,false);
  assert.deepEqual(vaultWorker(parsed),{role:"luna",profile:raw.luna,checkoutMode:"read"});
  assert.doesNotThrow(()=>assertVaultWorkerContract(parsed,{taskClass:"read_only_research"}));
  assert.throws(()=>assertVaultWorkerContract(parsed,{}),/explicit Luna/);
  assert.throws(()=>assertVaultWorkerContract(parseVaultRunConfig(base),{taskClass:"read_only_research"}),/explicit Luna/);
  for(const value of [{...raw,sol},{...raw,sol:undefined},{...common,luna:raw.luna},
    {...raw,taskMode:"unknown"},{...raw,luna:undefined},{...raw,lunaPolicy:"approved"}])
    assert.throws(()=>parseVaultRunConfig(value),/invalid|ambiguous/);
});
test("Vault run config rejects relative paths, repeated locks and uncontrolled commands", () => {
  assert.throws(() => parseVaultRunConfig({ ...base, checkout: "relative" }), /absolute path/);
  assert.throws(() => parseVaultRunConfig({ ...base, resources: ["Map", "map"] }), /repeated/);
  assert.throws(() => parseVaultRunConfig({ ...base, verification: [
    { program: "node", args: [], timeoutMs: 0 } ] }), /verification/);
});

test("Vault run maps each contract verification exactly once", () => {
  assert.doesNotThrow(() => assertVerificationCoverage(["A"], [
    { requirement: "A", program: "node", args: [], timeoutMs: 5000 } ]));
  assert.throws(() => assertVerificationCoverage(["A", "B"], [
    { requirement: "A", program: "node", args: [], timeoutMs: 5000 } ]), /does not map every/);
  assert.throws(() => assertVerificationCoverage(["A"], [
    { requirement: "A", program: "node", args: [], timeoutMs: 5000 },
    { requirement: "A", program: "node", args: [], timeoutMs: 5000 } ]), /repeated/);
});

test("Vault run keeps generated evidence outside checkout and Vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "negi-vault-run-"));
  try {
    const checkout = join(root, "checkout");
    const vault = join(root, "vault");
    await mkdir(checkout);
    await mkdir(vault);
    const config = parseVaultRunConfig({ ...base, checkout, vault,
      outputDir: join(root, "output"), schedulerPath: join(root, "scheduler.jsonl") });
    await assertVaultRunOutputPaths(config);
    await assert.rejects(assertVaultRunOutputPaths({ ...config,
      outputDir: join(checkout, "output") }), /outputDir must be outside/);
    await assert.rejects(assertVaultRunOutputPaths({ ...config,
      schedulerPath: join(vault, "scheduler.jsonl") }), /schedulerPath must be outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
