"""Optional ArkAnalyzer Node sidecar for Python whitebox rule evaluation."""

import json
import os
from pathlib import Path
import subprocess
import tempfile


def collect_ark_facts(project_path, case_dir=None, repo_root=None, environ=None):
    env = os.environ if environ is None else environ
    if env.get("HMOS_ARKANALYZER_ENABLE") != "true":
        return None
    root = Path(repo_root) if repo_root else Path(__file__).resolve().parents[3]
    sidecar_root = root / "src" / "whitebox_eval" / "ark_analyzer"
    sidecar = sidecar_root / "dist" / "rules" / "arkfacts" / "cli.js"
    if not sidecar.is_file():
        raise RuntimeError(f"ArkAnalyzer sidecar is not built: {sidecar}")
    options = {"projectPath": str(Path(project_path).resolve()),
               "caseDir": str(case_dir) if case_dir else None,
               "analyzerHome": env.get("HMOS_ARKANALYZER_HOME"),
               "analyzerScriptPath": env.get("HMOS_ARKANALYZER_SCRIPT_PATH"),
               "sdkHome": env.get("HMOS_ARKANALYZER_SDK_HOME") or env.get("OHOS_SDK_HOME"),
               "sdkPaths": [part.strip() for part in env.get("HMOS_ARKANALYZER_SDK_PATHS", "").split(os.pathsep)
                            if part.strip()]}
    with tempfile.TemporaryDirectory(prefix="whitebox-arkfacts-") as exchange:
        input_path = Path(exchange) / "input.json"
        output_path = Path(exchange) / "output.json"
        input_path.write_text(json.dumps(options, ensure_ascii=False), encoding="utf-8")
        run = subprocess.run(["node", str(sidecar), str(input_path), str(output_path)],
                             cwd=sidecar_root, capture_output=True, text=True,
                             timeout=120, check=False)
        if run.returncode:
            raise RuntimeError(f"ArkAnalyzer sidecar failed: {run.stderr.strip() or run.returncode}")
        return json.loads(output_path.read_text(encoding="utf-8"))
