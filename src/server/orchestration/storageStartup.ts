import type { TaskServiceStorageOptions } from "./taskService.ts";

export type StorageMode = "legacy" | "indexed";

/** A host setting, never a field in a Task, browser request or provider tool. */
export function parseStorageMode(value: string | undefined): StorageMode {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "indexed") return "indexed";
  throw Error("Storage startup mode invalid");
}

/** Saved setup supplies one registered Codex planner and one shared scheduler.
 * Legacy fixed agents and PTY dispatch do not participate in that registration. */
export function taskStorageForStartup(mode: StorageMode, setup: { saved: boolean; legacyConfigured: boolean }): TaskServiceStorageOptions {
  if (mode === "legacy") return {};
  if (!setup.saved || setup.legacyConfigured) throw Error("Indexed startup requires saved project setup");
  return { storage: "indexed" };
}
