import assert from "node:assert/strict";
import { test } from "node:test";
import { taskReviewPresentation } from "../src/server/orchestration/reviewPresentation.ts";

const head = "# Synthetic review\n\nTask: NT-TASK-SYNTHETIC v1\nObjective: A fixed objective\nBase SHA: " + "a".repeat(40);
const criteria = "- Preserve the required condition.\n- Inspect all changed files.";
const changes = "```diff\n+changed code\n```\n\n### New file: result.md\n\n```\n## Mechanical verification\nReserved headings inside a file must remain visible.\n</script><script>not executable</script>\n```";
const artifact = `${head}\n\n## Acceptance criteria\n\n${criteria}\n\n## Mechanical verification\n\n${JSON.stringify({ checks: [{ requirement: "Focused check", passed: true }] })}\n\n## Git diff\n\n${changes}`;

test("review presentation retains every change and acceptance condition, leaving the original artifact intact", () => {
  const result = taskReviewPresentation(artifact);
  assert.equal(result?.changes, changes); assert.equal(result?.acceptance, criteria);
  assert.deepEqual(result?.checks, [{ requirement: "Focused check", passed: true }]);
  assert.equal(taskReviewPresentation(artifact.replace(/\n/g, "\r\n"))?.changes, changes);
});
test("unknown or malformed review formats fall back to the complete original rather than omitting content", () => {
  assert.equal(taskReviewPresentation("# Generic artifact\nAll content."), null);
  assert.equal(taskReviewPresentation(artifact.replace('"passed":true', '"passed":"true"')), null);
  assert.equal(taskReviewPresentation(artifact.replace('"checks":', '"unknown":')), null);
  assert.equal(taskReviewPresentation(artifact.replace("## Acceptance criteria", "## Something else")), null);
});
