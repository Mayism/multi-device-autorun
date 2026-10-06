"""Isolated OpenCode runtime used by the Python whitebox workflow."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


REQUIRED = ("HMOS_OPENCODE_PORT", "HMOS_OPENCODE_HOST", "HMOS_OPENCODE_PROVIDER_ID",
            "HMOS_OPENCODE_MODEL_ID", "HMOS_OPENCODE_PROVIDER_CONFIG",
            "HMOS_OPENCODE_TIMEOUT_MS", "HMOS_OPENCODE_MAX_OUTPUT_BYTES")
SKILLS = ("hmos-understanding", "hmos-rubric-scoring", "hmos-rule-assessment",
          "hmos-human-rating-gap-analysis")
OUTPUT_FILE = re.compile(r"metadata/agent-output/[a-z-]+\.json\Z")


def _copy_file_entries(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        if entry.is_file():
            shutil.copy2(entry, destination / entry.name)


def _copy_skills(source, destination, repo_root):
    for name in SKILLS:
        if not (source / name / "SKILL.md").is_file():
            raise ValueError(f"缺少 opencode skill 文件：{name}/SKILL.md")
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(".DS_Store"))
    taxonomy = repo_root / "references" / "risks" / "risk-taxonomy.yaml"
    target = destination / "hmos-rubric-scoring" / "references" / "risk-taxonomy.yaml"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(taxonomy, target)


def create_runtime(repo_root, port=None, runtime_name=None, environ=None):
    env = dict(os.environ if environ is None else environ)
    missing = [key for key in REQUIRED if not str(env.get(key) or "").strip()]
    if missing:
        raise ValueError("缺少 opencode 环境变量：" + ", ".join(missing))
    if env["HMOS_OPENCODE_MODEL_ID"] in ("score-model", "replace_me", "your-model-id"):
        raise ValueError("HMOS_OPENCODE_MODEL_ID 仍是示例占位值")
    for key in ("HMOS_OPENCODE_PORT", "HMOS_OPENCODE_TIMEOUT_MS", "HMOS_OPENCODE_MAX_OUTPUT_BYTES"):
        if not str(env[key]).isdigit() or int(env[key]) <= 0:
            raise ValueError(f"{key} 必须是正整数")
    port = int(port or env["HMOS_OPENCODE_PORT"])
    root = Path(repo_root).resolve()
    config_dir = root / ".opencode"
    runtime = Path(env.get("HMOS_OPENCODE_RUNTIME_ROOT") or config_dir / "runtime").resolve()
    if runtime_name:
        runtime /= runtime_name
    try:
        template = (config_dir / "opencode.template.json").read_text(encoding="utf-8")
        provider = json.loads(env["HMOS_OPENCODE_PROVIDER_CONFIG"])
    except (OSError, ValueError) as error:
        raise ValueError(f"OpenCode 配置无效: {error}") from error
    template_values = {**env, "HMOS_OPENCODE_PORT": str(port)}
    def substitute(match):
        key = match.group(1)
        if key not in REQUIRED:
            raise ValueError(f"opencode 配置模板包含未知占位符：{match.group(0)}")
        return template_values[key]
    config = json.loads(re.sub(r"\$\{([A-Z0-9_]+)\}", substitute, template))
    if not isinstance(config, dict) or not isinstance(provider, dict):
        raise ValueError("OpenCode 配置必须是 JSON 对象")
    config["provider"] = {env["HMOS_OPENCODE_PROVIDER_ID"]: provider}
    config["formatter"]["agent-json"]["command"][0] = sys.executable
    for subdir in ("home", "xdg-config/opencode", "xdg-state", "xdg-data", "xdg-cache",
                   "prompts", "formatters", "skills", "xdg-config/opencode/prompts",
                   "xdg-config/opencode/formatters", "xdg-config/opencode/skills"):
        (runtime / subdir).mkdir(parents=True, exist_ok=True)
    for name in ("prompts", "formatters"):
        _copy_file_entries(config_dir / name, runtime / name)
        _copy_file_entries(config_dir / name, runtime / "xdg-config" / "opencode" / name)
    _copy_skills(config_dir / "skills", runtime / "skills", root)
    _copy_skills(config_dir / "skills", runtime / "xdg-config" / "opencode" / "skills", root)
    config_path = runtime / "opencode.generated.json"
    text = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    config_path.write_text(text, encoding="utf-8")
    (runtime / "xdg-config" / "opencode" / "opencode.json").write_text(text, encoding="utf-8")
    env.update({"HOME": str(runtime / "home"), "XDG_CONFIG_HOME": str(runtime / "xdg-config"),
                "XDG_STATE_HOME": str(runtime / "xdg-state"), "XDG_DATA_HOME": str(runtime / "xdg-data"),
                "XDG_CACHE_HOME": str(runtime / "xdg-cache"), "OPENCODE_CONFIG": str(config_path),
                "OPENCODE_CONFIG_DIR": str(config_dir)})
    return {"host": env["HMOS_OPENCODE_HOST"], "port": port,
            "serverUrl": f'http://{env["HMOS_OPENCODE_HOST"]}:{port}',
            "runtimeDir": str(runtime), "configPath": str(config_path), "env": env,
            "timeoutMs": int(env["HMOS_OPENCODE_TIMEOUT_MS"]),
            "maxOutputBytes": int(env["HMOS_OPENCODE_MAX_OUTPUT_BYTES"])}


class OpenCodeServer:
    def __init__(self, runtime):
        self.runtime = runtime
        self.process = None

    def _healthy(self):
        try:
            with urlopen(self.runtime["serverUrl"] + "/global/health", timeout=2) as response:
                return json.load(response).get("healthy") is True
        except (URLError, TimeoutError, OSError, ValueError):
            return False

    def start(self):
        if self.process is not None and self.process.poll() is None and self._healthy():
            return
        if not shutil.which("opencode", path=self.runtime["env"].get("PATH")):
            raise RuntimeError("opencode CLI 不存在，请先安装 opencode 并确保它在 PATH 中")
        self.process = subprocess.Popen(["opencode", "serve", "--hostname", self.runtime["host"],
                                         "--port", str(self.runtime["port"])],
                                        env=self.runtime["env"], stdout=subprocess.DEVNULL,
                                        stderr=subprocess.PIPE)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                reason = self.process.stderr.read(1000).decode("utf-8", errors="replace")
                raise RuntimeError(f"opencode serve 提前退出: {reason}")
            if self._healthy():
                return
            time.sleep(.2)
        self.stop()
        raise TimeoutError("opencode serve 健康检查超时")

    def stop(self):
        if self.process is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *_args):
        self.stop()


def _safe_tag(value):
    return re.sub(r"^-+|-+$", "", re.sub(r"[^A-Za-z0-9_.-]+", "-", value)) or "opencode"


def run_prompt(runtime, request):
    started = time.monotonic()
    sandbox = Path(request["sandboxRoot"]).resolve()
    tag = request["requestTag"]
    prompts = sandbox / "metadata" / "opencode-prompts"
    prompts.mkdir(parents=True, exist_ok=True)
    relative_prompt = f"metadata/opencode-prompts/{_safe_tag(tag)}.md"
    (sandbox / relative_prompt).write_text(request["prompt"], encoding="utf-8")
    output_file = request.get("outputFile")
    output_path = None
    if output_file:
        if not OUTPUT_FILE.fullmatch(output_file):
            raise ValueError(f"invalid agent output file: {output_file}")
        output_path = sandbox / output_file
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not request.get("preserveOutputFileOnStart"):
            output_path.unlink(missing_ok=True)
    args = ["opencode", "run", "--attach", runtime["serverUrl"], "--dir", str(sandbox),
            "--format", "json", "--title", request.get("title") or tag]
    if request.get("agent"):
        args += ["--agent", request["agent"]]
    if request.get("continueSessionId"):
        args += ["--session", request["continueSessionId"]]
    if output_file:
        args.append(f'Read and follow the prompt file at {relative_prompt}. Write the final JSON object to '
                    f'{output_file}. After writing the file, reply only with {{"output_file":"{output_file}"}}.')
    else:
        args.append(f"Read and follow the prompt file at {relative_prompt}. Return only the requested final JSON object.")
    try:
        run = subprocess.run(args, env=runtime["env"], capture_output=True,
                             timeout=runtime["timeoutMs"] / 1000, check=False)
    except subprocess.TimeoutExpired as error:
        raise TimeoutError(f"opencode 调用超时 request={tag}") from error
    if run.returncode:
        raise RuntimeError(f"opencode 调用失败 request={tag} exitCode={run.returncode} "
                           f"stderr={run.stderr[:1000].decode('utf-8', errors='replace')}")
    if len(run.stdout) > runtime["maxOutputBytes"]:
        raise RuntimeError(f"opencode 输出超过限制 request={tag}")
    events = run.stdout.decode("utf-8", errors="replace")
    records = []
    for line in events.splitlines():
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    for record in records:
        if isinstance(record, dict):
            error = record.get("error") or (record.get("properties") or {}).get("error")
            if error:
                detail = error.get("data", error) if isinstance(error, dict) else error
                raise RuntimeError(f"opencode 模型调用失败 {detail}")
    assistant = "".join(record["part"]["text"] for record in records if isinstance(record, dict)
                        and isinstance(record.get("part"), dict) and
                        record["part"].get("type") == "text" and
                        isinstance(record["part"].get("text"), str))
    if output_path:
        try:
            raw = output_path.read_text(encoding="utf-8")
        except OSError as error:
            raise RuntimeError(f"opencode agent output file missing request={tag} outputFile={output_file}") from error
    else:
        if not assistant.strip():
            raise RuntimeError(f"opencode 输出中缺少 assistant 最终文本 request={tag}")
        raw = assistant
    session = next((value for record in records if isinstance(record, dict)
                    for key in ("sessionId", "sessionID", "session_id", "id")
                    if isinstance((value := record.get(key)), str) and value.startswith("ses_")), None)
    return {"requestTag": tag, "rawText": raw, "rawEvents": events,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "sessionId": session, "assistantText": assistant or None,
            "outputFile": output_file, "outputFileText": raw if output_path else None}
