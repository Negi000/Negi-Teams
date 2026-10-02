import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { signedMasterOwner, validatedMasterOwner, type MasterOwnerPayload } from "../src/server/orchestration/masterConversationOwner.ts";

const key = randomBytes(32);
function payload(): MasterOwnerPayload {
  return { schema: "negi-master-conversation-owner/3", pid: process.pid, owner: randomUUID(), createdAt: new Date().toISOString(),
    masterId: "master", kind: "inspection", cwdSha256: "a".repeat(64), evidenceSha256: "b".repeat(64),
    operation: { domain: "master-conversation", requestId: randomUUID(), hash: "c".repeat(64) },
    processIdentity: { platform: "windows", pid: process.pid, startToken: "123" } };
}

test("owner/3 signs process creation identity while owner/2 remains byte-preserving historical evidence", () => {
  const modern = payload();const raw = signedMasterOwner(modern, key);
  assert.equal(JSON.stringify(validatedMasterOwner(JSON.parse(raw), "master", key)) + "\n", raw);
  const { processIdentity: _token, ...base } = modern as Extract<MasterOwnerPayload, { schema: "negi-master-conversation-owner/3" }>;
  const old = signedMasterOwner({ ...base, schema: "negi-master-conversation-owner/2" }, key);
  assert.equal(JSON.stringify(validatedMasterOwner(JSON.parse(old), "master", key)) + "\n", old);
  assert.equal("processIdentity" in JSON.parse(old), false);
  const forged = JSON.parse(raw);forged.processIdentity.startToken = "124";
  assert.throws(() => validatedMasterOwner(forged, "master", key), /signature mismatch/);
});

test("signed creation identity rejects missing, foreign, noncanonical and out-of-range tokens", () => {
  const base = payload() as Extract<MasterOwnerPayload, { schema: "negi-master-conversation-owner/3" }>;
  const invalid = [null, {}, { ...base.processIdentity, pid: process.pid + 1 }, { ...base.processIdentity, extra: true },
    ...["0", "01", "-1", "1.1", "18446744073709551616", "1\n"].map(startToken => ({ ...base.processIdentity, startToken }))];
  for (const processIdentity of invalid) {
    const raw = signedMasterOwner({ ...base, processIdentity } as MasterOwnerPayload, key);
    assert.throws(() => validatedMasterOwner(JSON.parse(raw), "master", key), /owner shape/);
  }
  const old = signedMasterOwner({ ...base, schema: "negi-master-conversation-owner/2" } as MasterOwnerPayload, key);
  assert.throws(() => validatedMasterOwner(JSON.parse(old), "master", key), /owner shape/);
});

test("native creation probe distinguishes same live owner, simulated PID reuse, and unknown query failures", { skip: process.platform !== "win32" }, async () => {
  const script = String.raw`import ctypes,json,os,sys
sys.path.insert(0,sys.argv[1])
import negi_recover_writer as m
k=m.windows_kernel();pid=os.getpid();handle=k.OpenProcess(0x00100000|0x1000,False,pid)
assert handle
times=[m.wintypes.FILETIME() for _ in range(4)]
try:
 assert k.GetProcessTimes(handle,*(ctypes.byref(value) for value in times))
 token=str(times[0].dwHighDateTime<<32|times[0].dwLowDateTime)
finally:k.CloseHandle(handle)
raw=json.loads(sys.stdin.buffer.read().decode('utf-8'));raw['pid']=pid;raw['processIdentity']['pid']=pid;raw['processIdentity']['startToken']=token
encode=lambda:json.dumps(raw,separators=(',',':')).encode('utf-8')
probe=lambda:m.observation(encode(),'master',lambda found:m.win_dead(k,found,m.master_start_token(encode(),'master')))
assert probe()['state']=='live'
try:m.win_dead(k,pid)
except ValueError:pass
else:raise AssertionError('legacy live PID was released')
raw['processIdentity']['startToken']='1'
assert probe()['state']=='dead'
raw['processIdentity']['startToken']=token
original=k.GetProcessTimes
def failed(*args):ctypes.set_last_error(5);return 0
k.GetProcessTimes=failed
try:
 result=probe();assert result['state']=='unknown' and result['operation'] is None
finally:k.GetProcessTimes=original
raw['processIdentity']={'platform':'linux','pid':pid,'startToken':'00000000-0000-0000-0000-000000000000:1'}
assert probe()['state']=='unknown'
print('live, simulated reuse, query failure and platform mismatch preserved')
`;
  const child = spawn("python", ["-B", "-c", script, resolve("scripts")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", error = "";child.stdout.on("data", chunk => { output += chunk; });child.stderr.on("data", chunk => { error += chunk; });
  const closed = new Promise<number | null>((accept, reject) => { child.once("close", accept);child.once("error", reject); });
  const timer = setTimeout(() => child.kill(), 10000);child.stdin.end(signedMasterOwner(payload(), key));
  try { assert.equal(await closed, 0, error);assert.equal(output.trim(), "live, simulated reuse, query failure and platform mismatch preserved"); }
  finally { clearTimeout(timer);child.kill();await closed; }
});
