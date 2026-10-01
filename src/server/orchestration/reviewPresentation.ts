// Presentation only. Acceptance always uses the signed, full artifact SHA and
// the existing evidence checks; this projection never decides a verification outcome.
import { parseMarkdown, type MdBlock } from "../../client/markdown.ts";
export interface TaskReviewPresentation {
  changes: string;
  acceptance: string;
  checks: Array<{ requirement: string; passed: boolean }>;
  blocks: MdBlock[];
}
export function taskReviewPresentation(content: string): TaskReviewPresentation | null {
  const text = content.replace(/\r\n/g, "\n");
  if (!/^# [^\n]+\n\nTask: [^\n]+\nObjective: [^\n]+\nBase SHA: [0-9a-f]{40}\n\n/.test(text)) return null;
  const acceptanceMarker = "\n\n## Acceptance criteria\n\n";
  const verificationMarker = "\n\n## Mechanical verification\n\n";
  const diffMarker = "\n\n## Git diff\n\n";
  const acceptance = text.indexOf(acceptanceMarker);
  const verification = text.indexOf(verificationMarker, acceptance + acceptanceMarker.length);
  const diff = text.indexOf(diffMarker, verification + verificationMarker.length);
  if (acceptance < 0 || verification <= acceptance || diff <= verification) return null;
  try {
    const evidence: unknown = JSON.parse(text.slice(verification + verificationMarker.length, diff).trim());
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
    const checks = (evidence as Record<string, unknown>).checks;
    if (!Array.isArray(checks) || checks.length > 100 || checks.some(check => !check || typeof check !== "object" ||
        typeof check.requirement !== "string" || typeof check.passed !== "boolean")) return null;
    // Everything after the generated diff heading is kept, including new-file
    // contents and any reserved headings appearing inside those contents.
    const changes = text.slice(diff + diffMarker.length).trim();
    const sourceBlocks = parseMarkdown(changes), blocks: MdBlock[] = [];
    for (let i = 0; i < sourceBlocks.length; i++) {
      const block = sourceBlocks[i], previous = sourceBlocks[i - 1];
      if (block.type === "code" && block.lang === "diff" && !block.value.trim()) continue;
      if (block.type === "code" && previous?.type === "heading" && previous.children.length === 1 &&
          previous.children[0].type === "text" && /^New file: .+\.md$/i.test(previous.children[0].value)) {
        blocks.push(...parseMarkdown(block.value));
      } else blocks.push(block);
    }
    return { acceptance: text.slice(acceptance + acceptanceMarker.length, verification).trim(), changes, blocks,
      checks: checks.map(check => ({ requirement: check.requirement, passed: check.passed })) };
  } catch { return null; }
}
