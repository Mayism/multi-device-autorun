import assert from "node:assert/strict";
import test from "node:test";
import * as pluginModule from "./opencode-auto-approve-plugin.mjs";

test("final config hook is the only export and removes plugin-injected ask and deny rules", async () => {
  const config = {
    permission: { external_directory: "deny" },
    agent: {
      generated: {
        permission: {
          "*": "allow",
          doom_loop: "ask",
          skill: { "*": "deny", selected: "allow" },
        },
      },
    },
  };
  assert.deepEqual(Object.keys(pluginModule), ["AutorunAutoApprovePlugin"]);
  const plugin = await pluginModule.AutorunAutoApprovePlugin();
  await plugin.config(config);
  assert.deepEqual(config.permission, { "*": "allow" });
  assert.deepEqual(config.agent.generated.permission, { "*": "allow" });
});

test("final config hook preserves the Autorun source Skill allowlist", async () => {
  const previous = process.env.AUTORUN_SKILL_ALLOWLIST_JSON;
  process.env.AUTORUN_SKILL_ALLOWLIST_JSON = JSON.stringify(["source-b", "source-a"]);
  try {
    const config = { permission: "deny", agent: { build: { permission: "deny" } } };
    const plugin = await pluginModule.AutorunAutoApprovePlugin();
    await plugin.config(config);
    const expected = {
      "*": "allow",
      skill: { "*": "deny", "source-a": "allow", "source-b": "allow" },
    };
    assert.deepEqual(config.permission, expected);
    assert.deepEqual(config.agent.build.permission, expected);
  } finally {
    if (previous === undefined) delete process.env.AUTORUN_SKILL_ALLOWLIST_JSON;
    else process.env.AUTORUN_SKILL_ALLOWLIST_JSON = previous;
  }
});
