import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverBatches } from "./merge-overview.mjs";

test("discovers new run/agent layout without flagging run overview as broken", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autorun-merge-"));
  const runRoot = path.join(root, "20260827143000");
  const agentRoot = path.join(runRoot, "harmonybot");
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.writeFileSync(path.join(runRoot, "overview.html"), "overview");
  fs.writeFileSync(path.join(agentRoot, "summary.json"), "{}");
  const result = discoverBatches({ root });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].rel, "20260827143000/harmonybot");
});
