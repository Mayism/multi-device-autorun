"""Compare Python and Node validation of the whitebox result contract."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_schema import validate_whitebox_result


ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "src" / "whitebox" / "references" / "scoring" / "report_result_schema.json"
VALIDATOR = ROOT / "src" / "whitebox" / "dist" / "report" / "resultSchemaValidator.js"
try:
    import jsonschema  # noqa: F401
    HAS_JSONSCHEMA = True
except ImportError:
    HAS_JSONSCHEMA = False


def minimal_value(schema):
    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        return schema["enum"][0]
    if "anyOf" in schema:
        return minimal_value(schema["anyOf"][0])
    if "allOf" in schema:
        return minimal_value(schema["allOf"][0])
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = kind[0]
    if kind == "object":
        return {key: minimal_value(schema["properties"][key])
                for key in schema.get("required", [])}
    if kind == "array":
        return [minimal_value(schema["items"])] * schema.get("minItems", 0)
    return {"string": "", "number": 0, "integer": 0, "boolean": False, "null": None}.get(kind)


@unittest.skipUnless(HAS_JSONSCHEMA and shutil.which("node") and VALIDATOR.is_file(),
                     "jsonschema or built whitebox validator unavailable")
class WhiteboxSchemaParityTests(unittest.TestCase):
    def test_valid_and_invalid_results_match_node(self):
        valid = minimal_value(json.loads(SCHEMA.read_text(encoding="utf-8")))
        cases = [valid, {}, {**valid, "extra": 1},
                 {**valid, "basic_info": {**valid["basic_info"], "task_type": "unknown"}}]
        source = ("import {validateReportResult} from " + json.dumps(VALIDATOR.as_uri()) + ";"
                  "let data='';for await(const c of process.stdin)data+=c;"
                  "try{validateReportResult(JSON.parse(data),process.argv[1]);process.stdout.write('valid')}"
                  "catch{process.stdout.write('invalid')}")
        for case in cases:
            with self.subTest(case=case):
                node = subprocess.run(["node", "--input-type=module", "-e", source, str(SCHEMA)],
                                      input=json.dumps(case), text=True, capture_output=True,
                                      check=True, cwd=ROOT / "src" / "whitebox")
                try:
                    validate_whitebox_result(case, SCHEMA)
                    python_status = "valid"
                except ValueError:
                    python_status = "invalid"
                self.assertEqual(python_status, node.stdout)


if __name__ == "__main__":
    unittest.main()
