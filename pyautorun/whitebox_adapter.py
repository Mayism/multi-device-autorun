"""Python batch interface to the intentionally retained whitebox Node evaluator."""

import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import subprocess

from .case_run import write_json
from .whitebox import resolve_judge
from .whitebox_report import render_whitebox_html, write_whitebox_html
from .whitebox_schema import validate_whitebox_result


async def resolve_judge_runtime(client, server_config, judge, generation_model, directory):
    try:
        raw = await client.get_providers(directory, 30)
        providers = raw if isinstance(raw, list) else (raw.get("providers") or
                    (raw.get("data") or {}).get("providers") or [])
    except Exception:
        providers = []
    return resolve_judge({"serverConfig": server_config, "runtimeProviders": providers,
                          "judge": judge, "generationModel": generation_model})


def prepare_whitebox_input(batch_id, case_info, agent_result, execution, config):
    case_dir = Path(agent_result["resultPath"]).parent
    output_dir = case_dir / "whitebox"
    inputs = output_dir / "inputs"
    original = case_dir / "original"
    generated = Path(agent_result["projectDir"])
    if not original.exists() or not generated.exists():
        raise ValueError(f"白盒原始或生成工程不存在: {original} / {generated}")
    patch = Path(agent_result.get("patchPath") or "")
    original_prompt = Path(case_info["promptPath"]).read_text(encoding="utf-8")
    additional = str(execution.get("additionalPrompt") or "").strip() if config["prompt"]["includeAdditionalPrompt"] else ""
    effective = "\n\n".join(item for item in (original_prompt.strip(), additional) if item) + "\n"
    inputs.mkdir(parents=True, exist_ok=True)
    original_prompt_path = inputs / "original-prompt.md"
    effective_prompt_path = inputs / "effective-prompt.md"
    original_prompt_path.write_text(original_prompt, encoding="utf-8")
    effective_prompt_path.write_text(effective, encoding="utf-8")
    raw_attempts = agent_result.get("agentCompileAttempts") or []
    attempts = [{"callId": str(item.get("callId") or ""), "command": str(item.get("command") or ""),
                 "tasks": [str(value) for value in item.get("tasks") or []],
                 "outcome": str(item.get("outcome") or "unknown"),
                 "exitCode": item.get("exitCode"), "startedAt": str(item.get("startedAt") or ""),
                 "finishedAt": str(item.get("finishedAt") or ""), "durationMs": item.get("durationMs") or 0,
                 "description": str(item.get("description") or "")} for item in raw_attempts]
    final = next((item for item in reversed(attempts) if item["outcome"] in
                  ("succeeded", "failed", "interrupted", "running")), None)
    final_status = final["outcome"] if final else "not_run"
    build_status = {"succeeded": "success", "failed": "failed", "interrupted": "interrupted",
                    "running": "unknown"}.get(final_status, "not_run")
    compile_usage = agent_result.get("agentCompile") or {}
    agent_build = {"source": "agent", "status": build_status, "finalAttemptStatus": final_status,
                   "attempts": attempts, "summary": {key: compile_usage.get(key) or (len(attempts) if key == "attempts" else 0)
                    for key in ("attempts", "succeeded", "failed", "interrupted", "running")}}
    manifest = {"schemaVersion": "whitebox-input-v1", "caseId": case_info["name"],
                "taskType": "continuation", "promptPath": str(effective_prompt_path),
                "originalProjectPath": str(original), "generatedProjectPath": str(generated),
                "outputDir": str(output_dir), "agentBuild": agent_build,
                "metadata": {"batchId": batch_id, "providerId": agent_result.get("providerId") or "",
                             "modelId": agent_result.get("modelId") or "",
                             "promptSha256": sha256(effective.encode()).hexdigest(),
                             "originalPromptPath": str(original_prompt_path),
                             "includesAdditionalPrompt": bool(additional)}}
    if patch.is_file():
        manifest["patchPath"] = str(patch)
        manifest["metadata"]["patchSha256"] = sha256(patch.read_bytes()).hexdigest()
    input_path = inputs / "input.json"
    write_json(input_path, manifest)
    return {"inputPath": str(input_path), "outputDir": str(output_dir)}


class WhiteboxEvaluator:
    def __init__(self, config, judge_runtime, opencode_bin, repo_root):
        self.config = config
        self.judge_runtime = judge_runtime
        self.opencode_bin = opencode_bin
        self.repo_root = Path(repo_root)
        self.cli = self.repo_root / "src" / "whitebox" / "dist" / "localCli.js"
        if not self.cli.is_file():
            raise ValueError(f"白盒评价尚未构建: {self.cli}；请执行 npm run build:whitebox")
        self.semaphore = asyncio.Semaphore(config["concurrency"])
        self.ports = asyncio.Queue()
        for offset in range(config["concurrency"]):
            self.ports.put_nowait(config["judge"]["basePort"] + offset)
        self.judge = {key: judge_runtime[key] for key in ("providerId", "modelId")}

    def _run(self, task, port):
        env = os.environ.copy()
        env["PATH"] = str(Path(self.opencode_bin).parent) + os.pathsep + env.get("PATH", "")
        env.update({"HMOS_OPENCODE_HOST": "127.0.0.1", "HMOS_OPENCODE_PORT": str(port),
                    "HMOS_OPENCODE_PROVIDER_ID": self.judge_runtime["providerId"],
                    "HMOS_OPENCODE_MODEL_ID": self.judge_runtime["modelId"],
                    "HMOS_OPENCODE_PROVIDER_CONFIG": json.dumps(self.judge_runtime["providerConfig"]),
                    "HMOS_OPENCODE_TIMEOUT_MS": str(self.config["timeoutSec"] * 1000),
                    "HMOS_OPENCODE_MAX_OUTPUT_BYTES": "1048576",
                    "HMOS_OPENCODE_RUNTIME_ROOT": self.config["runtimeRoot"],
                    "HMOS_CODE_LINTER_ENABLED": str(self.config["officialLinter"]["enabled"]).lower(),
                    "HMOS_HVIGOR_BUILD_CHECK_ENABLED": str(self.config["hvigorBuildCheck"]["enabled"]).lower()})
        output = Path(task["outputDir"])
        log_path = output / "logs" / "evaluator-process.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        node = shutil.which("node")
        if not node:
            return {"status": "failed", "error": "白盒评价需要 Node，但 PATH 中未找到 node"}
        try:
            completed = subprocess.run([node, str(self.cli), "--input", task["inputPath"], "--port", str(port)],
                                       cwd=self.cli.parent.parent, env=env, capture_output=True, text=True,
                                       timeout=self.config["timeoutSec"], check=False)
        except subprocess.TimeoutExpired:
            return {"status": "timed_out", "error": f"白盒评价超时（{self.config['timeoutSec']} 秒）"}
        log_path.write_text(completed.stdout + ("\n[stderr]\n" + completed.stderr if completed.stderr else ""),
                            encoding="utf-8")
        parsed = None
        for line in reversed(completed.stdout.splitlines()):
            if line.lstrip().startswith("{"):
                try:
                    parsed = json.loads(line)
                    break
                except ValueError:
                    pass
        if completed.returncode == 0 and isinstance(parsed, dict) and parsed.get("status") == "completed":
            try:
                result_path = Path(parsed.get("resultPath") or output / "outputs" / "result.json")
                result_json = json.loads(result_path.read_text(encoding="utf-8"))
                try:
                    import jsonschema  # noqa: F401
                except ImportError:
                    pass  # The retained Node evaluator already validated this result.
                else:
                    validate_whitebox_result(result_json, self.repo_root / "src" / "whitebox" /
                                             "references" / "scoring" / "report_result_schema.json")
                report_path = output / "report.html"
                if report_path.is_file() and report_path.read_text(encoding="utf-8") != render_whitebox_html(result_json):
                    raise ValueError("Python 与 Node 白盒 HTML 报告不一致")
                write_whitebox_html(result_json, report_path)
                parsed["reportPath"] = str(report_path)
            except (OSError, ValueError, TypeError) as error:
                return {"status": "failed", "error": f"Python 白盒报告生成失败: {error}",
                        "outputDir": str(output)}
            return parsed
        return {"status": "failed", "error": (parsed or {}).get("error") or
                completed.stderr.strip() or f"白盒评价进程退出码 {completed.returncode}", **(parsed or {})}

    async def schedule(self, task):
        async with self.semaphore:
            port = await self.ports.get()
            try:
                result = await asyncio.to_thread(self._run, task, port)
                return {**result, "judge": self.judge}
            finally:
                self.ports.put_nowait(port)
