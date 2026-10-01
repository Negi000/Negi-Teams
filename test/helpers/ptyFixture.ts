// A local Node process replaces Unix cat/shebang fixtures and echoes stdin once.
import { fileURLToPath } from "node:url";
import type { LaunchParams } from "../../src/server/agent.ts";
import type { Registry } from "../../src/server/registry.ts";
import type { Agent } from "../../src/server/agent.ts";

const consumer = fileURLToPath(new URL("./ptyConsumer.mjs", import.meta.url));
export function ptyFixtureLaunch(cwd: string, bridge = false): LaunchParams {
  return { command: process.execPath,
    args: [consumer, ...(bridge ? ["--mcp-config", "synthetic-unused"] : [])],
    cwd, model: null, ...(bridge ? { backend: "claude" as const } : {}) };
}

export async function readyPtyFixture(agent: Agent): Promise<Agent> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (agent.getScrollback().includes("PTY_FIXTURE_READY") && agent.getStatus() === "idle") return agent;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Local PTY fixture did not start and become idle");
}

export async function writePtyFixture(agent: Agent, text: string): Promise<void> {
  const mark = agent.scrollbackMark();
  agent.write(text);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (agent.getStatus() === "busy" && agent.scrollbackSince(mark).includes(text.trim())) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Local PTY fixture did not echo input and become busy");
}

export async function stopRegistry(registry: Pick<Registry, "list" | "get" | "killAll">): Promise<void> {
  const agents = registry.list().map((record) => registry.get(record.id)).filter((agent) => agent);
  registry.killAll();
  await Promise.all(agents.map((agent) => agent!.awaitExit(2000)));
}
