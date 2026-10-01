/** CLI names may be a PATH entry, a POSIX path, or a Windows executable path. */
export function matchesCommandName(command: string, name: string): boolean {
  const leaf = command.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return leaf.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase() === name;
}
