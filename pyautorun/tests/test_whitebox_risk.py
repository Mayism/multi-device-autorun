"""Compare the Python risk taxonomy and normalization with Node."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_risk import (load_risk_taxonomy, normalize_risk_item,
                                   resolve_primary_item)


ROOT = Path(__file__).resolve().parents[2]
TAXONOMY = ROOT / "src" / "whitebox" / "references" / "risks" / "risk-taxonomy.yaml"
MODULE = ROOT / "src" / "whitebox" / "dist" / "scoring" / "riskTaxonomy.js"
try:
    import yaml  # noqa: F401
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


@unittest.skipUnless(HAS_YAML and shutil.which("node") and MODULE.is_file(),
                     "PyYAML or built whitebox taxonomy unavailable")
class WhiteboxRiskParityTests(unittest.TestCase):
    def test_taxonomy_and_normalization_match(self):
        source = ("import {loadRiskTaxonomy,normalizeRiskItem,resolveRiskTaxonomyPrimaryItem} from "
                  + json.dumps(MODULE.as_uri()) + ";"
                  "const t=loadRiskTaxonomy(process.argv[1]);"
                  "const risks=[{risk_code:'OTHER_ISSUE',description:''},"
                  "{risk_code:'UNKNOWN_RISK',description:'specific'},{}];"
                  "process.stdout.write(JSON.stringify({taxonomy:t,normalized:risks.map(r=>normalizeRiskItem(r,t)),"
                  "primary:t.scoreEntries.map(e=>resolveRiskTaxonomyPrimaryItem(e,'continuation')??null)}));")
        node = subprocess.run(["node", "--input-type=module", "-e", source, str(TAXONOMY)],
                              capture_output=True, text=True, check=True, cwd=ROOT / "src" / "whitebox")
        expected = json.loads(node.stdout)
        taxonomy = load_risk_taxonomy(TAXONOMY)
        self.assertEqual(taxonomy, expected["taxonomy"])
        risks = [{"risk_code": "OTHER_ISSUE", "description": ""},
                 {"risk_code": "UNKNOWN_RISK", "description": "specific"}, {}]
        self.assertEqual([normalize_risk_item(risk, taxonomy) for risk in risks], expected["normalized"])
        self.assertEqual([resolve_primary_item(entry, "continuation") for entry in taxonomy["scoreEntries"]],
                         expected["primary"])


if __name__ == "__main__":
    unittest.main()
