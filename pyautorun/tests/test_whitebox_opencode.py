"""The Python whitebox OpenCode bridge prepares runtime and reads agent output."""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from pyautorun.whitebox_eval.runtime.opencode import create_runtime, run_prompt


ROOT = Path(__file__).resolve().parents[1] / "whitebox_eval" / "resources"


class WhiteboxOpenCodeTests(unittest.TestCase):
    def test_runtime_template_and_prompt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable = root / "opencode"
            executable.write_text("""#!""" + sys.executable + """
import json, pathlib, sys
args = sys.argv[1:]
directory = pathlib.Path(args[args.index('--dir')+1])
target = directory / 'metadata/agent-output/task-understanding.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text('{"ok":true}', encoding='utf8')
print(json.dumps({'part': {'type': 'text', 'text': '{"output_file":"metadata/agent-output/task-understanding.json"}'}}))
""", encoding="utf-8")
            executable.chmod(0o755)
            env = {**os.environ, "HMOS_OPENCODE_PORT": "62400", "HMOS_OPENCODE_HOST": "127.0.0.1",
                   "HMOS_OPENCODE_PROVIDER_ID": "sample", "HMOS_OPENCODE_MODEL_ID": "model",
                   "HMOS_OPENCODE_PROVIDER_CONFIG": '{"models":{"model":{}}}',
                   "HMOS_OPENCODE_TIMEOUT_MS": "30000", "HMOS_OPENCODE_MAX_OUTPUT_BYTES": "1048576",
                   "HMOS_OPENCODE_RUNTIME_ROOT": str(root / "runtime"),
                   "PATH": str(root) + os.pathsep + os.environ.get("PATH", "")}
            runtime = create_runtime(ROOT, runtime_name="test", environ=env)
            config = json.loads(Path(runtime["configPath"]).read_text(encoding="utf-8"))
            self.assertEqual(config["server"]["port"], 62400)
            self.assertEqual(config["provider"], {"sample": {"models": {"model": {}}}})
            self.assertEqual(config["formatter"]["agent-json"]["command"][0], sys.executable)
            self.assertEqual(Path(runtime["env"]["OPENCODE_CONFIG_DIR"]),
                             Path(runtime["runtimeDir"]) / "xdg-config" / "opencode")
            self.assertTrue((Path(runtime["runtimeDir"]) / "skills" /
                             "hmos-rubric-scoring" / "SKILL.md").is_file())
            sandbox = root / "sandbox"
            sandbox.mkdir()
            result = run_prompt(runtime, {"sandboxRoot": str(sandbox), "requestTag": "understanding",
                                          "prompt": "test", "agent": "hmos-understanding",
                                          "outputFile": "metadata/agent-output/task-understanding.json"})
            self.assertEqual(json.loads(result["rawText"]), {"ok": True})
            self.assertEqual((sandbox / "metadata/opencode-prompts/understanding.md").read_text(), "test")


if __name__ == "__main__":
    unittest.main()
