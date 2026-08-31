import assert from "node:assert/strict";
import test from "node:test";
import {
  forceAllowEverything,
  permissionPolicyAllowsExecution,
  permissionPolicyAllowsEverything,
  serverAllowsExecution,
  serverAllowsEverything,
} from "./permission-policy.mjs";

test("permission policy only accepts unconditional allow policies", () => {
  assert.equal(permissionPolicyAllowsEverything("allow"), true);
  assert.equal(permissionPolicyAllowsEverything({ "*": "allow" }), true);
  assert.equal(permissionPolicyAllowsEverything({ "*": "allow", external_directory: "deny" }), false);
  assert.equal(permissionPolicyAllowsEverything({ bash: "allow" }), false);
});

test("execution permission accepts an exact skill allowlist", () => {
  const policy = {
    "*": "allow",
    skill: { "*": "deny", "source-skill": "allow" },
  };
  assert.equal(permissionPolicyAllowsEverything(policy), false);
  assert.equal(permissionPolicyAllowsExecution(policy), true);
  assert.equal(permissionPolicyAllowsExecution({ "*": "allow", bash: "deny", skill: policy.skill }), false);
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

test("runtime config can restrict skills without restricting other tools", () => {
  const config = forceAllowEverything({
    agent: { selected: { permission: "deny" } },
  }, { allowedSkills: ["source-b", "source-a", "source-a"] });
  const expected = {
    "*": "allow",
    skill: {
      "*": "deny",
      "source-a": "allow",
      "source-b": "allow",
    },
  };
  assert.deepEqual(config.permission, expected);
  assert.deepEqual(config.agent.selected.permission, expected);
  assert.equal(serverAllowsEverything(config, "selected"), false);
  assert.equal(serverAllowsExecution(config, "selected"), true);
});
