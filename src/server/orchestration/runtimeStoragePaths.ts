import { resolve } from "node:path";

/** Persistent registration survives a missing DB; default writers must hold. */
export function runtimeStoragePaths(schedulerPath: string) {
  const path = resolve(schedulerPath);
  return { database: path + ".negi-runtime.sqlite3", registration: path + ".negi-runtime-registration.json" };
}
