"""Named, report-based scoring rules for Harmony Eval."""

import json
import math
from pathlib import Path

from pyautorun.harmony_eval.verification import VerificationSpec, get_verifier


SCORERS = {}
SCORER_TYPES = {}


def register_scorer(name, verifier_types=()):
    """Register one pure report-to-score function under a stable name."""
    def decorator(function):
        if name in SCORERS:
            raise ValueError(f"评分规则重复注册: {name}")
        SCORERS[name] = function
        SCORER_TYPES[name] = tuple(verifier_types)
        return function
    return decorator


def _read_report(path):
    if not path:
        raise ValueError("评估器未提供结果报告路径")
    report_path = Path(path)
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"无法读取结果报告 {report_path}: {error}") from error
    if not isinstance(report, dict):
        raise ValueError(f"结果报告必须是 JSON 对象: {report_path}")
    return report


def _specs(enabled):
    if isinstance(enabled, dict):
        return [VerificationSpec(name, get_verifier(name).type_name, bool(active))
                for name, active in enabled.items()]
    return [item if isinstance(item, VerificationSpec) else VerificationSpec(**item) for item in enabled]


def _resolve_verification(entry, specs):
    name = entry.get("name") or entry.get("type")
    requested = str(entry.get("verification") or "").strip()
    active = [spec for spec in specs if spec.enabled]
    matches = [spec for spec in active if spec.id == requested or spec.type.lower() == requested.lower()] if requested else [
        spec for spec in active if not SCORER_TYPES[name] or spec.type in SCORER_TYPES[name]]
    if len(matches) != 1:
        raise ValueError(f"评分规则 {name!r} 无法唯一确定启用的评估器 {requested!r}；请指定 verification.id")
    spec = matches[0]
    if SCORER_TYPES[name] and spec.type not in SCORER_TYPES[name]:
        raise ValueError(f"评分规则 {name!r} 不支持评估器 {spec.type!r}")
    return spec


def validate_scoring(entries, enabled):
    """Fail early on unknown rules or a score without its report producer."""
    if not isinstance(entries, list):
        raise ValueError("harmonybot_agent.scoring 必须是列表")
    specs = _specs(enabled)
    seen = set()
    normalized = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"scoring[{index}] 必须是对象")
        dimension = str(entry.get("dimension") or "").strip()
        name = str(entry.get("name") or entry.get("type") or "").strip()
        if not dimension or dimension in seen:
            raise ValueError(f"scoring[{index}].dimension 为空或重复: {dimension}")
        if name not in SCORERS:
            raise ValueError(f"未知评分规则 {name!r}；可用规则: {', '.join(sorted(SCORERS))}")
        spec = _resolve_verification(entry, specs)
        seen.add(dimension)
        normalized.append({**entry, "verification": spec.id})
    return normalized


def score_case(entries, result):
    """Score each configured dimension from its saved evaluator report."""
    scores = {}
    for entry in entries:
        dimension = entry["dimension"]
        name = entry.get("name") or entry.get("type")
        verification = str(entry.get("verification") or "")
        if not verification:
            types = SCORER_TYPES.get(name) or ()
            if len(types) != 1:
                raise ValueError(f"评分规则 {name!r} 需要指定 verification")
            verification = types[0]
        canonical = (result.get("verifications") or {}).get(verification) or {}
        if canonical:
            source = canonical.get("reportPath") or ""
        else:
            try:
                plugin = get_verifier(verification)
            except ValueError:
                plugin = None
            source = (plugin(VerificationSpec(verification, plugin.type_name)).report_path(
                result.get(plugin.legacy_result_key) or {}) if plugin else "")
        try:
            report = _read_report(source)
            value = SCORERS[name](report, entry)
            if not isinstance(value, (float, int)) or isinstance(value, bool) or not math.isfinite(value):
                raise ValueError("评分规则必须返回有限数字")
            scores[dimension] = {"status": "scored", "score": float(value), "rule": name,
                                 "verification": verification, "sourceReport": source}
        except (OSError, ValueError, KeyError, TypeError) as error:
            scores[dimension] = {"status": "unavailable", "score": None, "rule": name,
                                 "verification": verification, "sourceReport": source or "",
                                 "error": str(error)}
    return scores


def summarize_scores(results, entries):
    """Average usable scores without treating unavailable reports as zero."""
    summary = {}
    for entry in entries:
        dimension = entry["dimension"]
        cases = [(item.get("scoring") or {}).get(dimension) or {} for item in results]
        values = [item["score"] for item in cases if item.get("status") == "scored"]
        summary[dimension] = {"rule": entry.get("name") or entry.get("type"),
                              "scored": len(values), "total": len(cases),
                              "average": sum(values) / len(values) if values else None}
    return summary


@register_scorer("BooleanScoring", ("UITest",))
def score_uitest(report, _config):
    """Temporary L1 rule: every executed device test must pass."""
    run = ((report.get("runs") or {}).get("swe") or {})
    devices = run.get("devices") or []
    if not devices:
        raise ValueError("UITest 报告没有 swe.devices")
    executed = [item for item in devices if int(item.get("testsRun") or 0) > 0]
    total = sum(int(item.get("testsRun") or 0) for item in executed)
    if total < 1:
        raise ValueError("UITest 报告没有实际执行的测试")
    failed = sum(int(item.get("failures") or 0) + int(item.get("errors") or 0) for item in executed)
    return 1.0 if failed == 0 and all(item.get("status") == "passed" for item in executed) else 0.0


@register_scorer("WeightedSummation", ("CloudTest",))
def score_cloudtest(report, config):
    """Temporary L2 rule: weighted device and rule pass rates, each in [0, 1]."""
    summary = ((report.get("report") or {}).get("summary") or {})
    device_total = int(summary.get("devicePassed") or 0) + int(summary.get("deviceFailed") or 0)
    rule_total = int(summary.get("rulePassed") or 0) + int(summary.get("ruleFailed") or 0)
    if not device_total and not rule_total:
        raise ValueError("云测试报告缺少设备及规则统计")
    weights = config.get("weights") or {"device": 0.5, "rule": 0.5}
    components = []
    if device_total:
        components.append((float(weights.get("device", 0.5)), summary["devicePassed"] / device_total))
    if rule_total:
        components.append((float(weights.get("rule", 0.5)), summary["rulePassed"] / rule_total))
    if any(not math.isfinite(weight) or weight < 0 for weight, _ in components):
        raise ValueError("云测试评分权重必须是非负有限数字")
    weight_sum = sum(weight for weight, _ in components)
    if weight_sum <= 0:
        raise ValueError("云测试评分权重之和必须大于 0")
    return sum(weight * value for weight, value in components) / weight_sum


@register_scorer("ImmediateValue", ("Whitebox",))
def score_whitebox(report, _config):
    """Temporary L3 rule: use the whitebox report's published totalScore."""
    value = report.get("totalScore")
    if value is None:
        raise ValueError("白盒报告缺少 totalScore")
    return float(value)
