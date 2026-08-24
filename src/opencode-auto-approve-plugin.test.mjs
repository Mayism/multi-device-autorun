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
