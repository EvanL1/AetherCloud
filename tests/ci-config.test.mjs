import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const workflowUrl = new URL("../.github/workflows/check.yml", import.meta.url);

test("pull requests and main are gated by the complete repository check", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /^name: Cloud Check$/m);
  assert.match(workflow, /^ {2}pull_request:$/m);
  assert.match(workflow, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.doesNotMatch(workflow, /^ {4}paths:/m);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /corepack enable pnpm/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /run: pnpm check/);
  assert.match(workflow, /permissions:\n {2}contents: read/);

  for (const action of workflow.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(
      action[1],
      /@[0-9a-f]{40}(?:\s|$)/,
      `GitHub Action must be pinned by commit: ${action[1]}`,
    );
  }
});
