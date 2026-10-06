"""Isolated Agent target setup and multi-target input snapshots."""

from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path

from pyautorun.orchestration.case_run import safe_name, write_json
from pyautorun.runtime.opencode_installation import resolve_opencode_source
from pyautorun.orchestration.preflight import wait_for_skills
from pyautorun.orchestration.sandbox_copy import copy_project
from pyautorun.runtime.skill_runtime import prepare_agent_skill_runtime, summarize_agent_skill_runtime


def _iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def allocate_run_directory(output_root):
    root = Path(output_root)
    root.mkdir(parents=True, exist_ok=True)
    base = datetime.now().strftime("%Y%m%d%H%M%S")
    identifier = base
    attempt = 2
    while (root / identifier).exists():
        identifier = f"{base}-{attempt}"
        attempt += 1
    run_root = root / identifier
    run_root.mkdir()
    return identifier, run_root


def config_for_target(config, target, run_id, cases_root, phase=""):
    clone = deepcopy(config)
    runtime = Path(config["server"]["runtimeRoot"]) / run_id / safe_name(target["id"])
    if phase:
        runtime /= safe_name(phase)
    clone["server"]["opencodeSource"] = dict(target)
    clone["server"]["runtimeRoot"] = str(runtime / "opencode")
    clone["execution"]["agent"] = target["agent"]
    clone["execution"]["casesRoot"] = str(cases_root)
    clone["whiteboxEvaluation"]["runtimeRoot"] = str(runtime / "whitebox")
    return clone, runtime


def _fingerprint_directory(root):
    root = Path(root)
    entries = sorted((path for path in root.rglob("*") if path.is_file() or path.is_symlink()),
                     key=lambda path: path.relative_to(root).as_posix())
    digest = sha256()
    for path in entries:
        relative = path.relative_to(root).as_posix()
        kind = "link" if path.is_symlink() else "file"
        value = os.readlink(path).encode() if kind == "link" else path.read_bytes()
        for part in (kind.encode(), relative.encode(), value):
            digest.update(part)
            digest.update(b"\0")
    return {"sha256": digest.hexdigest(), "fileCount": len(entries)}


def create_shared_cases_snapshot(config, run_id, run_root):
    source = config["execution"]["casesRoot"]
    snapshot = Path(config["server"]["runtimeRoot"]) / run_id / "shared" / "cases"
    copy_project(source, snapshot)
    fingerprint = _fingerprint_directory(snapshot)
    write_json(Path(run_root) / "input-snapshot.json", {"schemaVersion": "autorun-input-snapshot-v1",
               "sourceCasesRoot": source, "snapshotRoot": str(snapshot), **fingerprint, "createdAt": _iso()})
    return str(snapshot)


def prepare_shared_generation_provider(config, run_id):
    generation = config["execution"]["generationModel"]
    provider_id, model_id = generation["providerId"], generation["modelId"]
    preferred = str(config["execution"].get("providerSourceTargetId") or "").strip()
    targets = config["server"]["opencodeTargets"]["targets"]
    if preferred and preferred not in [target["id"] for target in targets]:
        raise ValueError(f"execution.providerSourceTargetId 不存在: {preferred}")
    ordered = sorted(targets, key=lambda target: target["id"] != preferred) if preferred else targets
    for target in ordered:
        source = resolve_opencode_source(target)
        try:
            raw = json.loads((Path(source["resourcesDir"]) / "opencode.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        provider = (raw.get("provider") or {}).get(provider_id)
        if not provider or model_id not in (provider.get("models") or {}):
            continue
        overlay = Path(config["server"]["runtimeRoot"]) / run_id / "shared" / "generation-provider.json"
        write_json(overlay, {"providerId": provider_id,
                             "provider": {**provider, "models": {model_id: provider["models"][model_id]}}})
        try:
            overlay.chmod(0o600)
        except OSError:
            pass
        return str(overlay)
    return ""


def _sanitized_hash(value):
    import re
    secret = re.compile(r"api[-_]?key|token|secret|password|authorization|cookie|credential", re.I)
    def clean(item):
        if isinstance(item, list):
            return [clean(value) for value in item]
        if isinstance(item, dict):
            return {key: "<redacted>" if secret.search(key) else clean(item[key]) for key in sorted(item)}
        return item
    return sha256(json.dumps(clean(value), ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


async def write_target_environment(target_root, target, target_config, server, model):
    skills = await wait_for_skills(server.client, target_config["execution"]["casesRoot"])
    skills = skills if isinstance(skills, list) else []
    registered = sorted({str(item.get("name") or item.get("id") or "").strip() for item in skills
                         if isinstance(item, dict) and (item.get("name") or item.get("id"))})
    resources = dict(server.tool_resources or {})
    if target["mode"] == "harmonyBot":
        resources["skillNames"] = registered
    runtime = prepare_agent_skill_runtime(resources, skills, target_config["execution"]["agent"], target["mode"])
    source_skills = sorted(set(resources.get("skillNames") or []))
    if target["mode"] == "softwareEngineering":
        missing = [name for name in source_skills if name not in registered]
        if missing:
            raise ValueError(f"Agent {target['id']} 来源 Skill 未注册: {', '.join(missing)}")
        policy = (((server.server_config.get("agent") or {}).get(target_config["execution"]["agent"]) or {}).get("permission") or
                  server.server_config.get("permission") or {}).get("skill") or {}
        allowed = sorted(name for name, value in policy.items() if name != "*" and value == "allow")
        if policy.get("*") != "deny" or allowed != source_skills:
            raise ValueError(f"Agent {target['id']} 未应用来源 Skill 精确白名单")
    elif not source_skills and registered:
        raise ValueError(f"Agent {target['id']} 来源 skills 为空，但 Server 实际加载了 Skill: {', '.join(registered)}")
    provider = (server.server_config.get("provider") or {}).get(model["providerId"]) or {}
    source = server.source
    manifest = {"schemaVersion": "autorun-agent-environment-v1", "targetId": target["id"],
                "label": target["label"], "mode": target["mode"],
                "agent": target_config["execution"]["agent"],
                "generationModel": {**model, "configFingerprint": _sanitized_hash(model)},
                "source": {"root": source["root"], "resourcesDir": source["resourcesDir"],
                           "opencodeBinPath": source["opencodeBinPath"],
                           "version": (source.get("installation") or {}).get("version") or "",
                           "configFingerprint": _sanitized_hash({"opencode": server.server_config,
                                                                  "provider": provider,
                                                                  "model": (provider.get("models") or {}).get(model["modelId"])})},
                "isolation": {"dedicatedServer": True,
                              "runtimeRoot": target_config["server"]["runtimeRoot"] if target["mode"] == "softwareEngineering" else "plugin-managed",
                              "workspace": str(Path(target_config["server"]["runtimeRoot"]).parent / "workspace"),
                              "configAssets": "copied_snapshot" if target["mode"] == "softwareEngineering" else "plugin_managed",
                              "skillPolicy": "strict_source_allowlist" if target["mode"] == "softwareEngineering" else "plugin_loaded_locations"},
                "skills": {"sourceDirectories": source_skills, "loaded": [name for name in registered if name in source_skills],
                           "blocked": [name for name in registered if name not in source_skills]},
                "skillRuntime": summarize_agent_skill_runtime(runtime), "createdAt": _iso()}
    write_json(Path(target_root) / "environment.json", manifest)
    return manifest, runtime
