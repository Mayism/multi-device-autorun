import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_AUTO_APPROVAL_POLICY,
  applyAgentSessionPolicy,
  hasAgentSessionPolicy,
} from "./session-policy.mjs";

test("unattended policy is appended to the selected Agent session prompt", () => {
  const config = {
    agent: {
      selected: { prompt: "existing plugin instructions", mode: "primary" },
      other: { prompt: "other instructions" },
    },
  };
  const result = applyAgentSessionPolicy(config, { agentName: "selected" });
  assert.equal(result.agent.selected.mode, "primary");
  assert.equal(result.agent.selected.prompt, `existing plugin instructions\n\n${AGENT_AUTO_APPROVAL_POLICY}`);
  assert.equal(result.agent.other.prompt, "other instructions");
  assert.equal(hasAgentSessionPolicy(result, "selected"), true);
  assert.equal(hasAgentSessionPolicy(result, "other"), false);
});

test("unattended policy can configure a built-in Agent", () => {
  const result = applyAgentSessionPolicy({}, { agentName: "build" });
  assert.equal(result.agent.build.prompt, AGENT_AUTO_APPROVAL_POLICY);
  assert.equal(hasAgentSessionPolicy(result, "build"), true);
});
