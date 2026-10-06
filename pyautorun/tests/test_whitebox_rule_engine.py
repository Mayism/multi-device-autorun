"""The standalone Python rule engine matches the existing Node engine."""

import json
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from pyautorun.whitebox_rule_engine import run_rule_engine


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
ENGINE = WHITEBOX / "dist" / "rules" / "core" / "ruleEngine.js"


@unittest.skipUnless(shutil.which("node") and ENGINE.is_file() and importlib.util.find_spec("yaml"),
                     "built rule engine or PyYAML unavailable")
class RuleEngineParityTests(unittest.TestCase):
    def test_standalone_engine(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = root / "original"
            generated = root / "generated"
            for path in (original, generated):
                (path / "entry" / "src" / "main").mkdir(parents=True)
            (original / "entry" / "src" / "main" / "Page.ets").write_text(
                "@Component struct Page { build() { Text('hello') } }", encoding="utf-8")
            (generated / "entry" / "src" / "main" / "Page.ets").write_text(
                "@Component struct Page { build() { Column() { GridRow({columns:{sm:4,md:8}}) { GridCol() { Text('hello') } } } } }", encoding="utf-8")
            (generated / "entry" / "src" / "main" / "module.json5").write_text(
                "{module:{type:'entry',deviceTypes:['phone','tablet']}}", encoding="utf-8")
            case = {"caseId": "sample", "promptText": "Make an app",
                    "originalProjectPath": str(original), "generatedProjectPath": str(generated),
                    "originalProjectProvided": True}
            env = {**os.environ, "HMOS_ARKANALYZER_ENABLE": "false",
                   "HMOS_WHITEBOX_PYTHON_RULES_ENABLE": "false"}
            enabled = ["arkts-language", "arkts-performance", "arkui-extra", "cross-device-adaptation"]
            actual = run_rule_engine(case, "continuation", enabled_pack_ids=enabled,
                                     repo_root=ROOT, environ=env)
            source = ("import {runRuleEngine} from " + json.dumps(ENGINE.as_uri()) + ";"
                      "const caseInput=JSON.parse(process.argv[1]);"
                      "const result=await runRuleEngine({referenceRoot:'',caseInput,taskType:'continuation',"
                      "enabledRulePackIds:" + json.dumps(enabled) + "});"
                      "process.stdout.write(JSON.stringify(result));")
            result = subprocess.run(["node", "--input-type=module", "-e", source,
                                     json.dumps(case)], cwd=WHITEBOX, env=env, text=True,
                                    capture_output=True, check=True)
            expected = json.loads(result.stdout)
            self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
