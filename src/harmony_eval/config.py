"""Normalize task YAML without binding scenarios to executors or scoring rules."""

from copy import deepcopy
from pathlib import Path

from pyautorun.harmony_eval.core import safe_id, datasets, targets, executors, verifiers, scorers


def read_yaml(path):
    import yaml
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def resolve(base, value):
    return str((Path(base) / Path(value).expanduser()).resolve())


def object_value(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"{name} 必须为对象")
    return value


def positive(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} 必须为正整数")
    return value


def validate_model(model):
    object_value(model, "model")
    for key in ("name", "base_url", "api_key"):
        if not isinstance(model.get(key), str) or not model[key].strip():
            raise ValueError(f"model.{key} 不能为空")
    if model.get("api_type", "openai_api") not in ("openai_api", "openai_compatible"):
        raise ValueError("当前模型适配支持 api_type: openai_api/openai_compatible")
    if not model["base_url"].startswith(("http://", "https://")):
        raise ValueError("model.base_url 必须是 HTTP(S) URL")
    from pyautorun.harmony_eval.model import normalize_api_key
    model["api_key"] = normalize_api_key(model["api_key"])


def flow_order(items):
    by_id = {v["id"]: v for v in items}
    if len(by_id) != len(items):
        raise ValueError("verification.id 不得重复")
    result, visiting, done = [], set(), set()
    def visit(name):
        if name not in by_id:
            raise ValueError(f"不存在的评估流程依赖: {name}")
        if name in visiting:
            raise ValueError(f"评估流程依赖成环: {name}")
        if name in done:
            return
        visiting.add(name)
        for dep in by_id[name].get("depends_on", []):
            visit(dep)
        visiting.remove(name)
        done.add(name)
        result.append(by_id[name])
    for item in items:
        visit(item["id"])
    return result


def normalize_flow(flow, base, stack=()):
    object_value(flow, "verification 条目")
    flow["id"] = safe_id(flow.get("id") or flow.get("type", ""))
    if not isinstance(flow.get("depends_on", []), list):
        raise ValueError("depends_on 必须是流程 ID 数组")
    for key in ("prompt_path", "rubric_path", "skill_path", "workflow_path", "deveco_home", "flutter_home", "emulator_deployed_dir"):
        if flow.get(key):
            flow[key] = resolve(base, flow[key])
    nested_base = base
    if flow.get("workflow_path"):
        path = flow["workflow_path"]
        if path in stack or len(stack) >= 16:
            raise ValueError("组合评估流程循环引用或嵌套过深")
        settings = object_value(read_yaml(path), "workflow 文件")
        flow.setdefault("steps", settings.get("steps", []))
        flow.setdefault("metrics", settings.get("metrics", {}))
        stack, nested_base = (*stack, path), Path(path).parent
    if "steps" in flow:
        if not isinstance(flow["steps"], list):
            raise ValueError("Workflow.steps 必须为数组")
        for step in flow["steps"]:
            normalize_flow(step, nested_base, stack)
        flow["steps"] = flow_order(flow["steps"])
    if flow.get("model"):
        validate_model(flow["model"])
    verifiers.validate(flow.get("type"), flow)


def load_task(path):
    # Imports register builtins; extension entry points use exactly the same contracts.
    from pyautorun.harmony_eval import dataset_adapters, target_adapters, execution, verification, score_rules  # noqa
    source = Path(path).expanduser().resolve()
    raw = object_value(read_yaml(source), "task")
    task = deepcopy(raw)
    task["id"] = safe_id(task.get("id", ""))
    if not task.get("scenario") or "/" in task["scenario"]:
        raise ValueError("scenario 必须填写一个场景名称")
    version = task.get("schema_version", 2)
    if version != 2:
        raise ValueError("请使用 schema_version: 2；旧 Autorun JSON 入口仍可独立使用")
    if task.get("runtime_config"):
        raise ValueError("runtime_config 已取消，请在 execution.enviroment 和 verification 中配置环境")
    task["schema_version"] = 2
    task["source"] = str(source)
    task["base_dir"] = str(source.parent)
    data = object_value(task.get("dataset"), "dataset")
    if not data.get("dir"):
        raise ValueError("dataset.dir 不能为空")
    data["dir"] = resolve(source.parent, data["dir"])
    if not Path(data["dir"]).exists():
        raise ValueError(f"dataset.dir 不存在: {data['dir']}")
    if data.get("limit") is not None:
        positive(data["limit"], "dataset.limit")
    datasets.validate(data.get("type"), data)
    target = object_value(task.get("target"), "target")
    kind = target.get("type")
    if kind == "knowledge_agent":
        raise ValueError("knowledge_agent 为预留字段；MCP 任务请选择 harmonybot_agent/opencode_agent")
    target_cls = targets.validate(kind, target)
    if target.get("dir"):
        target["dir"] = resolve(source.parent, target["dir"])
    block = object_value(task.get(kind), kind)
    task["active"] = block
    block["rounds"] = positive(block.get("rounds", 1), "rounds")
    if block["rounds"] > 100:
        raise ValueError("rounds 不得超过 100")
    execution = object_value(block.get("execution"), "execution")
    if "runtime" in execution:
        raise ValueError("execution.runtime 已更名为 enviroment")
    execution.setdefault("engine", "http" if kind in ("knowledge", "http_agent") else "opencode")
    if getattr(target_cls, "engine", execution["engine"]) != execution["engine"]:
        raise ValueError(f"目标{kind}需要engine: {target_cls.engine}")
    execution["timeout"] = positive(execution.get("timeout", 900), "execution.timeout")
    execution["idle_timeout"] = positive(execution.get("idle_timeout", 300), "execution.idle_timeout")
    execution["concurrency"] = positive(execution.get("concurrency", 1), "execution.concurrency")
    if "without_enable" in execution:
        if kind not in ("skills", "plugin_agent"):
            raise ValueError("without_enable 仅用于 skills/plugin_agent；MCP 请修改 opencode.json")
        if not isinstance(execution["without_enable"], bool):
            raise ValueError("without_enable 必须是布尔值")
    env = object_value(execution.setdefault("enviroment", {}), "enviroment")
    for key, value in env.items():
        if value:
            env[key] = resolve(source.parent, value)
    oc = object_value(execution.setdefault("opencode", {}), "execution.opencode")
    if kind == "plugin_agent" and oc.get("plugins"):
        raise ValueError("被测 Plugin 统一由 target 定义，请将 execution.opencode.plugins 的 entry/options 等移到 target")
    for key in ("config_path", "binary"):
        if oc.get(key):
            oc[key] = resolve(source.parent, oc[key])
    executors.validate(execution["engine"], execution)
    if execution["engine"] == "opencode":
        if not execution.get("agent_name"):
            raise ValueError("execution.agent_name 必须指定实际 Agent ID")
        if execution["agent_name"] == "一多适配Agent":
            execution["agent_name"] = "harmonyos-multi-device"
        validate_model(execution.get("model"))
    flows = block.get("verification") or []
    if not isinstance(flows, list):
        raise ValueError("verification 必须为数组")
    for flow in flows:
        normalize_flow(flow, source.parent)
    block["verification"] = flow_order(flows)
    scoring = block.get("scoring") or []
    if not isinstance(scoring, list):
        raise ValueError("scoring 必须为数组")
    dimensions = set()
    flow_ids = {flow["id"] for flow in flows}
    def validate_sources(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in ("source", "cap_source") and (not isinstance(item, str) or item.split(".")[0] not in flow_ids):
                    raise ValueError(f"评分引用了不存在的评估流程: {item}")
                validate_sources(item)
        elif isinstance(value, list):
            for item in value:
                validate_sources(item)
    for rule in scoring:
        object_value(rule, "scoring 条目")
        dimension = safe_id(rule.get("dimension", ""))
        if dimension in dimensions:
            raise ValueError(f"重复评分维度: {dimension}")
        dimensions.add(dimension)
        scorers.validate(rule.get("type"), rule)
        validate_sources(rule)
    block["scoring"] = scoring
    report = object_value(block.get("report"), "report")
    if not report.get("output_dir") or report.get("format", "html") not in ("html", "json"):
        raise ValueError("report 需要 output_dir，format 支持 html/json")
    report["output_dir"] = resolve(source.parent, report["output_dir"])
    task["variant"] = "without" if execution.get("without_enable") else "with"
    return task
