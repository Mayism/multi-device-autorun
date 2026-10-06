"""Python build gate summarizes upstream Agent results like the Node workflow."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_build_check import agent_build_summary, run_hvigor_check


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
TOOLS = WHITEBOX / "dist" / "workflow" / "nodes" / "officialCodeLinter" / "tools.js"


@unittest.skipUnless(shutil.which("node") and TOOLS.is_file(), "built build-check helpers unavailable")
class WhiteboxBuildCheckTests(unittest.TestCase):
    def test_agent_result(self):
        agent = {"status": "failed", "attempts": [{"callId": "c", "command": "assembleHap",
                  "tasks": ["assembleHap"], "outcome": "failed", "exitCode": 1,
                  "durationMs": 20, "description": "build"}],
                 "summary": {"attempts": 1, "succeeded": 0, "failed": 1, "interrupted": 0,
                             "running": 0}}
        source = ("import {resolveBuildCheckSummary} from " + json.dumps(TOOLS.as_uri()) + ";"
                  "const value=await resolveBuildCheckSummary({hvigorEnabled:false,changedFiles:[],"
                  "timeoutMs:30000,agentBuildResult:JSON.parse(process.argv[1])});"
                  "process.stdout.write(JSON.stringify(value));")
        node = subprocess.run(["node", "--input-type=module", "-e", source, json.dumps(agent)],
                              cwd=WHITEBOX, check=True, text=True, capture_output=True)
        self.assertEqual(agent_build_summary(agent), json.loads(node.stdout))

    def test_disabled_check(self):
        result = run_hvigor_check(False)
        self.assertEqual(result["status"], "not_enabled")
        self.assertFalse(result["hardGateTriggered"])


if __name__ == "__main__":
    unittest.main()
