import assert from "node:assert/strict";
import test from "node:test";

import { collectCompileAttempts } from "./compile-usage.mjs";

function toolPart(command, { id, exit = 0, status = "completed" } = {}) {
  return {
    id: id || command,
    type: "tool",
    tool: "bash",
    state: {
      status,
      input: { command },
      metadata: { exit },
    },
  };
}

function collect(...parts) {
  return collectCompileAttempts([{
    sessionId: "session-1",
    messages: [{ parts }],
  }]);
}

test("counts devecocli HarmonyOS builds and their outcomes", () => {
  const result = collect(
    toolPart("devecocli build", { id: "failed", exit: 1 }),
    toolPart("devecocli build --product default", { id: "passed" }),
  );

  assert.equal(result.attempts, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.succeeded, 1);
});

test("counts a chained clean followed by a HarmonyOS build once", () => {
  const result = collect(toolPart("devecocli build clean && devecocli build"));

  assert.equal(result.attempts, 1);
  assert.equal(result.succeeded, 1);
});

test("does not count clean-only or Web build commands", () => {
  const result = collect(
    toolPart("devecocli build clean", { id: "clean" }),
    toolPart("npm run build", { id: "npm" }),
    toolPart("pnpm build", { id: "pnpm" }),
    toolPart("yarn build", { id: "yarn" }),
  );

  assert.equal(result.attempts, 0);
  assert.deepEqual(result.items, []);
});
