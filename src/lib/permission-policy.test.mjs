import assert from "node:assert/strict";
import test from "node:test";
import {
  forceAllowEverything,
  permissionPolicyAllowsEverything,
  serverAllowsEverything,
} from "./permission-policy.mjs";

test("permission policy only accepts unconditional allow policies", () => {
  assert.equal(permissionPolicyAllowsEverything("allow"), true);
  assert.equal(permissionPolicyAllowsEverything({ "*": "allow" }), true);
  assert.equal(permissionPolicyAllowsEverything({ "*": "allow", external_directory: "deny" }), false);
  assert.equal(permissionPolicyAllowsEverything({ bash: "allow" }), false);
});

test("runtime config forces global and agent permissions to allow", () => {
  const raw = {
    permission: { bash: "ask", external_directory: "deny" },
    agent: {
      selected: { permission: { edit: "deny" }, prompt: "selected" },
      hidden: { prompt: "hidden" },
    },
  };
  const { config, missingAgents } = forceAllowEverything(raw, ["selected"]);
  assert.equal(config.permission, "allow");
  assert.deepEqual(Object.keys(config.agent), ["selected"]);
  assert.deepEqual(config.agent.selected.permission, { "*": "allow" });
  assert.deepEqual(missingAgents, []);
  assert.equal(serverAllowsEverything(config, "selected"), true);
});
