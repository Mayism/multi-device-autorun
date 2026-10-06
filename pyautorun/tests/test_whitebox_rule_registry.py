"""Compare Python rule-pack loading with the existing rule registry."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_rule_registry import (enabled_rule_packs, load_rule_packs,
                                               registered_rules, resolve_enabled_pack_ids)


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
REGISTRY = WHITEBOX / "dist" / "rules" / "registry" / "rulePackRegistry.js"


@unittest.skipUnless(shutil.which("node") and REGISTRY.is_file(), "built Node registry unavailable")
class WhiteboxRuleRegistryTests(unittest.TestCase):
    def test_all_rule_packs_match_node(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML unavailable")
        source = ("import {getRegisteredRulePacks,getEnabledRulePacks,listRegisteredRules,"
                  "resolveEnabledRulePackIds} from " + json.dumps(REGISTRY.as_uri()) + ";"
                  "const packs=getRegisteredRulePacks();"
                  "const enabled=resolveEnabledRulePackIds({crossDeviceAdaptation:{applicability:'involved'}});"
                  "process.stdout.write(JSON.stringify({packs,enabled,selected:getEnabledRulePacks(enabled),"
                  "rules:listRegisteredRules({enabledPackIds:enabled})}));")
        node = subprocess.run(["node", "--input-type=module", "-e", source],
                              cwd=WHITEBOX, capture_output=True, text=True, check=True)
        expected = json.loads(node.stdout)
        packs = load_rule_packs(WHITEBOX / "references" / "rules")
        self.assertEqual(packs, expected["packs"])
        enabled = resolve_enabled_pack_ids({"crossDeviceAdaptation": {"applicability": "involved"}})
        self.assertEqual(enabled, expected["enabled"])
        self.assertEqual(enabled_rule_packs(packs, enabled), expected["selected"])
        self.assertEqual(registered_rules(packs, enabled), expected["rules"])


if __name__ == "__main__":
    unittest.main()
