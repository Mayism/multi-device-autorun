import assert from "node:assert/strict";
import test from "node:test";
import { forceRuntimePermissions } from "./opencode-auto-approve-plugin.mjs";

test("final config hook removes plugin-injected ask and deny rules", () => {
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
  forceRuntimePermissions(config);
  assert.deepEqual(config.permission, { "*": "allow" });
  assert.deepEqual(config.agent.generated.permission, { "*": "allow" });
});
