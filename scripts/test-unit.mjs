// Expand test paths in Node so npm test works with Windows and POSIX shells.
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const files = (await readdir(new URL("../test/", import.meta.url)))
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => new URL(`../test/${file}`, import.meta.url));
const child = spawn(process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=4", ...files.map(fileURLToPath)],
  { stdio: "inherit", windowsHide: true });
child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
