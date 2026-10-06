"""Load and validate whitebox rule packs without the Node rule registry."""

from pathlib import Path


PACK_ORDER = ("arkts-language.yaml", "arkts-performance.yaml", "arkui-extra.yaml",
              "cross-device-adaptation.yaml")
DEFAULT_PACK_IDS = ("arkts-language", "arkts-performance", "arkui-extra")
ROOT_KEYS = {"name", "version", "summary", "rule_pack_meta", "must_rules", "should_rules", "forbidden_patterns"}
META_KEYS = {"pack_id", "source_name", "source_version"}
RULE_KEYS = {"id", "rule", "detector", "fallback", "profile", "rule_name", "priority", "decisionCriteria"}
DETECTOR_KEYS = {"kind", "mode", "provider", "config"}
PROFILE_KEYS = {"scoring", "riskCode", "suppressRubricRiskCodes", "metricGroups", "impact"}
MODES = {"regex", "project_structure", "arkui_extra", "arkui_static",
         "case_constraint_precheck", "arkts_static", "api_usage"}
METRIC_GROUPS = {"type_safety", "static_quality", "naming", "complexity", "state_flow",
                 "stability", "security_boundary", "performance", "arkui_organization", "harmony_engineering"}


def _record(value, location, keys=None):
    if not isinstance(value, dict):
        raise ValueError(f"{location} must be an object")
    for key in value:
        if keys is not None and key not in keys:
            raise ValueError(f"Unsupported field at {location}: {key}")
    return value


def _string(value, location):
    if not isinstance(value, str):
        raise ValueError(f"{location} must be a string")
    return value


def _strings(value, location):
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{location} must only contain strings")
    return value


def _choice(value, choices, location):
    if _string(value, location) not in choices:
        raise ValueError(f"{location} must be one of {', '.join(sorted(choices))}")
    return value


def _rule(value, pack_id, source, location):
    raw = _record(value, location, RULE_KEYS)
    detector = _record(raw.get("detector"), f"{location}.detector", DETECTOR_KEYS)
    kind = _choice(detector.get("kind"), {"static", "agent", "external", "none"}, f"{location}.detector.kind")
    normalized_detector = {"kind": kind}
    if kind == "static":
        normalized_detector["mode"] = _choice(detector.get("mode"), MODES, f"{location}.detector.mode")
    elif kind == "external":
        normalized_detector["provider"] = _choice(detector.get("provider"), {"official_code_linter"},
                                                  f"{location}.detector.provider")
    normalized_detector["config"] = dict(_record(detector.get("config", {}), f"{location}.detector.config"))
    fallback = _record(raw.get("fallback"), f"{location}.fallback", {"policy"})
    policy = _choice(fallback.get("policy"), {"agent_assisted", "not_applicable"}, f"{location}.fallback.policy")
    profile = _record(raw.get("profile"), f"{location}.profile", PROFILE_KEYS)
    scoring = profile.get("scoring")
    if not isinstance(scoring, bool):
        raise ValueError(f"{location}.profile.scoring must be a boolean")
    groups = _strings(profile.get("metricGroups", []), f"{location}.profile.metricGroups")
    if any(group not in METRIC_GROUPS for group in groups):
        raise ValueError(f"{location}.profile.metricGroups contains an unsupported group")
    impact = _choice(profile.get("impact", "light"), {"light", "medium", "heavy"},
                     f"{location}.profile.impact")
    normalized_profile = {"scoring": scoring, "metricGroups": groups, "impact": impact}
    if "riskCode" in profile:
        normalized_profile["riskCode"] = _string(profile["riskCode"], f"{location}.profile.riskCode")
    if "suppressRubricRiskCodes" in profile:
        normalized_profile["suppressRubricRiskCodes"] = _strings(
            profile["suppressRubricRiskCodes"], f"{location}.profile.suppressRubricRiskCodes")
    if scoring and (not normalized_profile.get("riskCode") or not groups):
        raise ValueError(f"{location}.profile requires riskCode and metricGroups when scoring is true")
    summary = _string(raw.get("rule"), f"{location}.rule")
    result = {"pack_id": pack_id, "rule_id": _string(raw.get("id"), f"{location}.id"),
              "rule_source": source, "summary": summary, "detector": normalized_detector,
              "fallback": {"policy": policy}, "profile": normalized_profile}
    if "rule_name" in raw:
        result["rule_name"] = _string(raw["rule_name"], f"{location}.rule_name")
    elif normalized_detector.get("mode") == "case_constraint_precheck":
        result["rule_name"] = summary.split("。", 1)[0].strip() or summary
    if "priority" in raw:
        result["priority"] = _choice(raw["priority"], {"P0", "P1"}, f"{location}.priority")
    elif normalized_detector.get("mode") == "case_constraint_precheck" and source in ("must_rule", "should_rule"):
        result["priority"] = "P0" if source == "must_rule" else "P1"
    if "decisionCriteria" in raw:
        criteria = _record(raw["decisionCriteria"], f"{location}.decisionCriteria",
                           {"pass", "fail", "notApplicable", "review"})
        result["decisionCriteria"] = {key: _strings(item, f"{location}.decisionCriteria.{key}")
                                      for key, item in criteria.items()}
    return result


def parse_rule_pack(document, location):
    root = _record(document, location, ROOT_KEYS)
    meta = _record(root.get("rule_pack_meta"), f"{location}.rule_pack_meta", META_KEYS)
    pack_id = _string(meta.get("pack_id"), f"{location}.rule_pack_meta.pack_id")
    pack = {"packId": pack_id, "displayName": _string(root.get("name"), f"{location}.name")}
    if "version" in root:
        pack["version"] = _string(root["version"], f"{location}.version")
    rules = []
    for key, source in (("must_rules", "must_rule"), ("should_rules", "should_rule"),
                        ("forbidden_patterns", "forbidden_pattern")):
        group = root.get(key, [])
        if not isinstance(group, list):
            raise ValueError(f"{location}.{key} must be an array")
        rules.extend(_rule(item, pack_id, source, f"{location}.{key}[{index}]")
                     for index, item in enumerate(group))
    pack["rules"] = rules
    return pack


def load_rule_packs(directory):
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("Python 白盒规则包读取需要 PyYAML；安装 pip install '.[whitebox]'") from error
    root = Path(directory)
    if not root.exists():
        return []
    files = sorted(root.glob("*.yaml"), key=lambda path: (PACK_ORDER.index(path.name) if path.name in PACK_ORDER
                                                             else len(PACK_ORDER), path.name))
    return [parse_rule_pack(yaml.safe_load(path.read_text(encoding="utf-8")), str(path)) for path in files]


def enabled_rule_packs(packs, pack_ids):
    selected = set(pack_ids)
    return [pack for pack in packs if pack["packId"] in selected]


def normalize_runtime_rule(rule):
    if "detector" in rule:
        return rule
    result = {"pack_id": rule["pack_id"], "rule_id": rule["rule_id"],
              "rule_source": rule["rule_source"], "summary": rule["summary"],
              "detector": {"kind": "static", "mode": "case_constraint_precheck",
                           "config": rule["detector_config"]},
              "fallback": {"policy": rule["fallback_policy"]}}
    for key in ("rule_name", "priority", "is_case_rule"):
        if key in rule:
            result[key] = rule[key]
    return result


def registered_rules(packs, enabled_ids=None, runtime_rules=()):
    selected = enabled_rule_packs(packs, enabled_ids) if enabled_ids is not None else packs
    return [rule for pack in selected for rule in pack["rules"]] + [normalize_runtime_rule(rule)
                                                                     for rule in runtime_rules]


def resolve_enabled_pack_ids(understanding):
    result = list(DEFAULT_PACK_IDS)
    if (understanding or {}).get("crossDeviceAdaptation", {}).get("applicability") == "involved":
        result.append("cross-device-adaptation")
    return result
