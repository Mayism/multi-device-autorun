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
  const config = forceAllowEverything(raw);
  assert.equal(config.permission, "allow");
  assert.deepEqual(Object.keys(config.agent), ["selected", "hidden"]);
  assert.deepEqual(config.agent.selected.permission, { "*": "allow" });
  assert.deepEqual(config.agent.hidden.permission, { "*": "allow" });
  assert.equal(serverAllowsEverything(config, "selected"), true);
});
