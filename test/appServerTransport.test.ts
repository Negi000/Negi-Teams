import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AppServerTransport } from "../src/server/master/appServerTransport.ts";

function fixture(options: ConstructorParameters<typeof AppServerTransport>[2] = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let sent = "";
  output.on("data", (chunk: Buffer) => { sent += chunk.toString("utf8"); });
  const transport = new AppServerTransport(input, output, options);
  return { input, output, transport, sent: () => sent };
}

test("split UTF-8 frames, multiple messages and response IDs", async () => {
  const notices: string[] = [];
  const f = fixture({ onNotification: (method) => notices.push(method) });
  const first = f.transport.request("thread/start", { model: "gpt-6-astra" });
  const second = f.transport.request("turn/start", { input: [{ type: "text", text: "x" }] });
  const requests = f.sent().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((r) => r.id), [1, 2]);
  assert.deepEqual(requests.map((r) => r.jsonrpc), ["2.0", "2.0"]);
  const bytes = Buffer.from('{"method":"note/未知","params":{"text":"日本"}}\n{"id":2,"result":{"turnId":"t2"}}\n{"id":1,"result":{"threadId":"t1"}}\n');
  const split = bytes.indexOf(Buffer.from("日")) + 1;
  f.input.write(bytes.subarray(0, split));
  f.input.write(bytes.subarray(split));
  assert.deepEqual(await second, { turnId: "t2" });
  assert.deepEqual(await first, { threadId: "t1" });
  assert.deepEqual(notices, ["note/未知"]);
  assert.equal(f.transport.pendingCount, 0);
  f.transport.close();
});

test("timeout and disconnect leave unknown outcome and never retry", async () => {
  const f = fixture({ timeoutMs: 10 });
  const pending = f.transport.request("turn/start", { input: [] });
  await assert.rejects(pending, /outcome unknown/);
  assert.equal(f.sent().trim().split("\n").length, 1);
  f.input.write('{"id":1,"result":{"turnId":"late"}}\n');
  const next = f.transport.request("turn/interrupt", { threadId: "t", turnId: "u" });
  f.input.end();
  await assert.rejects(next, /outcome unknown/);
  assert.equal(f.transport.pendingCount, 0);
});

test("server requests fail closed unless handled; oversized input closes transport", async () => {
  const f = fixture({ maxLineBytes: 128 });
  f.input.write('{"id":77,"method":"item/commandExecution/requestApproval","params":{}}\n');
  assert.deepEqual(JSON.parse(f.sent().trim()), {
    jsonrpc: "2.0", id: 77, error: { code: -32601, message: "No server request handler" },
  });
  const pending = f.transport.request("initialize", {});
  f.input.write("a".repeat(129));
  await assert.rejects(pending, /transport limit/);
  assert.equal(f.transport.pendingCount, 0);
});

test("explicit approval handler keeps response bound to original ID", () => {
  let requested: { id: string | number; method: string } | null = null;
  const f = fixture({ onServerRequest: (id, method) => { requested = { id, method }; } });
  f.input.write('{"id":"approval-4","method":"item/fileChange/requestApproval","params":{}}\n');
  assert.deepEqual(requested, { id: "approval-4", method: "item/fileChange/requestApproval" });
  assert.equal(f.sent(), "");
  f.transport.respond("approval-4", { decision: "decline" });
  assert.deepEqual(JSON.parse(f.sent().trim()), { jsonrpc: "2.0", id: "approval-4", result: { decision: "decline" } });
  f.transport.close();
});

test("invalid UTF-8 rejects in-flight request", async () => {
  const f = fixture();
  const pending = f.transport.request("thread/read", { threadId: "t" });
  f.input.write(Buffer.from([0xff, 0x0a]));
  await assert.rejects(pending, /invalid UTF-8/);
});

test("a large chunk of small lines is accepted but one oversized line closes", async () => {
  const notices: string[] = [];
  const f = fixture({ maxLineBytes: 128, onNotification: (method) => notices.push(method) });
  f.input.write(Buffer.from(Array.from({ length: 1000 },
    () => '{"method":"small/notice"}\n').join("")));
  assert.equal(notices.length, 1000);
  const pending = f.transport.request("turn/start", {});
  f.input.write(Buffer.from('{"method":"small/notice"}\n' + "x".repeat(129) + "\n"));
  await assert.rejects(pending, /transport limit/);
  assert.equal(notices.length, 1001);
  assert.equal(f.transport.pendingCount, 0);
});

test("late stream errors after transport close are handled", () => {
  const f = fixture();
  f.transport.close();
  assert.doesNotThrow(() => f.input.emit("error", new Error("late input error")));
  assert.doesNotThrow(() => f.output.emit("error", new Error("late output error")));
});
