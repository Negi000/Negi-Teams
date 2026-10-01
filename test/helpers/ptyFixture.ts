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
  await waitPtyFixture(agent, a => a.getScrollback().includes("PTY_FIXTURE_READY") && a.getStatus() === "idle",
    "start and become idle");
  return agent;
}
/** Observe fixture output/state; short sleeps cannot synchronize a loaded ConPTY host. */
export async function waitPtyFixture(agent: Agent, observed: (agent: Agent) => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (true) {
    if (observed(agent)) return;
    if (Date.now() >= deadline) throw new Error(`Local PTY fixture did not ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function writePtyFixture(agent: Agent, text: string): Promise<void> {
  const mark = agent.scrollbackMark();
  agent.write(text);
  await waitPtyFixture(agent, a => a.getStatus() === "busy" && a.scrollbackSince(mark).includes(text.trim()),
    "echo input and become busy");
}

export async function stopRegistry(registry: Pick<Registry, "list" | "get" | "killAll">): Promise<void> {
  const agents = registry.list().map((record) => registry.get(record.id)).filter((agent) => agent);
  registry.killAll();
  await Promise.all(agents.map((agent) => agent!.awaitExit(2000)));
}
