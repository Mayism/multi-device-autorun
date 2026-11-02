"""Load per-case YAML constraints into Python runtime rule definitions."""

from pathlib import Path


def _record(value, location, keys):
    if not isinstance(value, dict):
        raise ValueError(f"{location} must be an object")
    unexpected = set(value) - set(keys)
    if unexpected:
        raise ValueError(f"Unsupported field at {location}: {next(iter(unexpected))}")
    return value


def _string(value, location):
    if not isinstance(value, str):
        raise ValueError(f"{location} must be a string")
    return value


def parse_constraint_file(value):
    if isinstance(value, list):
        constraints = value
    else:
        root = _record(value, "root", ("constraints",))
        constraints = root.get("constraints")
    if not isinstance(constraints, list):
        raise ValueError("constraints must be an array")
    parsed = []
    for index, item in enumerate(constraints):
        location = f"constraints[{index}]"
        item = _record(item, location, ("id", "name", "description", "priority", "kit", "rules"))
        priority = _string(item.get("priority"), location + ".priority")
        if priority not in ("P0", "P1"):
            raise ValueError(location + ".priority must be P0 or P1")
        rules = item.get("rules")
        if not isinstance(rules, list):
            raise ValueError(location + ".rules must be an array")
        checks = []
        for rule_index, rule in enumerate(rules):
            rule_location = f"{location}.rules[{rule_index}]"
            rule = _record(rule, rule_location, ("target", "ast", "llm"))
            ast = rule.get("ast", [])
            if not isinstance(ast, list):
                raise ValueError(rule_location + ".ast must be an array")
            signals = []
            for signal_index, signal in enumerate(ast):
                signal_location = f"{rule_location}.ast[{signal_index}]"
                if not isinstance(signal, dict):
                    raise ValueError(signal_location + " must be an object")
                signals.append({key: _string(value, f"{signal_location}.{key}")
                                for key, value in signal.items()})
            checks.append({"target": _string(rule.get("target"), rule_location + ".target"),
                           "astSignals": signals, "llmPrompt": _string(rule["llm"], rule_location + ".llm")
                           if "llm" in rule else ""})
        kit = item.get("kit")
        if not isinstance(kit, list):
            kit = None
        else:
            kit = [entry for entry in kit if isinstance(entry, str)] or None
        parsed.append({"id": _string(item.get("id"), location + ".id"),
                       "name": _string(item.get("name"), location + ".name"),
                       "description": (_string(item["description"], location + ".description")
                                       if "description" in item else None),
                       "priority": priority, "kit": kit, "checks": checks})
    return parsed


def load_case_constraints(case_input):
    path = case_input.get("expectedConstraintsPath")
    if not path:
        return []
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("Python 白盒用例约束读取需要 PyYAML；安装 pip install '.[whitebox]'") from error
    constraints = parse_constraint_file(yaml.safe_load(Path(path).read_text(encoding="utf-8")))
    result = []
    for constraint in constraints:
        checks = constraint["checks"]
        prompts = [item for item in checks if item["llmPrompt"]]
        llm = (prompts[0]["llmPrompt"] if len(prompts) == 1 else
               "\n".join(item["target"] + ": " + item["llmPrompt"] for item in prompts))
        config = {"targetPatterns": [item["target"] for item in checks],
                  "astSignals": [signal for item in checks for signal in item["astSignals"]],
                  "llmPrompt": llm}
        if constraint["kit"]:
            config["kit"] = constraint["kit"]
        if len(checks) > 1 or constraint["kit"]:
            config["targetChecks"] = checks
        result.append({"pack_id": "case-" + case_input["caseId"], "rule_id": constraint["id"],
                       "rule_name": constraint["name"], "rule_source":
                       "must_rule" if constraint["priority"] == "P0" else "should_rule",
                       "summary": (constraint["description"] or "").strip() or constraint["name"],
                       "priority": constraint["priority"], "detector_kind": "case_constraint",
                       "detector_config": config, "fallback_policy": "agent_assisted",
                       "is_case_rule": True})
    return result
