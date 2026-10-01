import type { TaskPlanFields } from "./taskAuthoring.ts";

export interface TaskDecompositionFields {
  title: string;
  objective: string;
  coordination: string[];
  nodes: Array<{ key: string; dependsOn: string[]; handoff: string; task: TaskPlanFields }>;
}
export interface TaskDecompositionNode {
  id: string;
  hash: string;
  title: string;
  objective: string;
  coordination: string[];
  key: string;
  position: number;
  dependsOn: string[];
  handoff: string;
}
const nodeKey = /^[a-z][a-z0-9-]{0,39}$/;
function text(raw: unknown, maximum: number): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > maximum || /[\0]/.test(raw) || raw.includes("```"))
    throw new Error("Task decomposition text invalid");
  return raw.trim();
}
/** A bounded planning graph, never execution authority for unresolved successors. */
export function taskDecomposition(raw: unknown, parseTask: (raw: unknown) => TaskPlanFields): TaskDecompositionFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Task decomposition invalid");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 4 || Object.keys(value).some(k => !["title", "objective", "coordination", "nodes"].includes(k)) ||
      !Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 8 ||
      !Array.isArray(value.coordination) || value.coordination.length < 1 || value.coordination.length > 8)
    throw new Error("Task decomposition shape invalid");
  const nodes = value.nodes.map(raw => {
    const n = raw as Record<string, unknown>;
    if (!n || Array.isArray(n) || Object.keys(n).length !== 4 ||
        Object.keys(n).some(k => !["key", "dependsOn", "handoff", "task"].includes(k)) ||
        typeof n.key !== "string" || !nodeKey.test(n.key) || !Array.isArray(n.dependsOn) || n.dependsOn.length > 7 ||
        n.dependsOn.some(k => typeof k !== "string" || !nodeKey.test(k)) || new Set(n.dependsOn).size !== n.dependsOn.length)
      throw new Error("Task decomposition node invalid");
    return { key: n.key, dependsOn: [...n.dependsOn] as string[], handoff: text(n.handoff, 500), task: parseTask(n.task) };
  });
  const byKey = new Map(nodes.map(n => [n.key, n]));
  if (byKey.size !== nodes.length) throw new Error("Task decomposition node repeated");
  const ancestors = new Map<string, Set<string>>();
  function visit(key: string, visiting: Set<string>): Set<string> {
    if (visiting.has(key)) throw new Error("Task decomposition has a dependency cycle");
    if (ancestors.has(key)) return ancestors.get(key)!;
    const node = byKey.get(key); if (!node) throw new Error("Task decomposition dependency missing");
    const found = new Set<string>(), next = new Set(visiting).add(key);
    for (const dep of node.dependsOn) { found.add(dep); for (const parent of visit(dep, next)) found.add(parent); }
    ancestors.set(key, found); return found;
  }
  for (const n of nodes) visit(n.key, new Set());
  // Incomparable nodes may run independently; their declared writers must be disjoint.
  for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
    const left = nodes[a], right = nodes[b];
    if (ancestors.get(left.key)!.has(right.key) || ancestors.get(right.key)!.has(left.key)) continue;
    if (left.task.allowedPaths.some(a => right.task.allowedPaths.some(b => {
      a = a.toLowerCase(); b = b.toLowerCase(); return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
    }))) throw new Error("Independent Task writers overlap; define a dependency or narrower ownership");
  }
  nodes.sort((a,b)=>ancestors.get(a.key)!.size-ancestors.get(b.key)!.size);
  const result = { title: text(value.title, 160), objective: text(value.objective, 2000),
    coordination: value.coordination.map(v => text(v, 500)), nodes };
  if (new Set(result.coordination).size !== result.coordination.length || Buffer.byteLength(JSON.stringify(result)) > 48_000)
    throw new Error("Task decomposition exceeds bounded planning context");
  return result;
}
