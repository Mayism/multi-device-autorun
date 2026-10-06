"""Build the existing autorun-agent-comparison-v1 data contract."""

import json
import math
from pathlib import Path
from urllib.parse import quote

from pyautorun.reporting.batch_report import _numeric, _obj, _list, _truthy


def _read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None


def _fallback(*values):
    return next((value for value in values if _truthy(value)), values[-1])


def _number(value):
    result = _numeric(value)
    return result if result is not None else 0


def _score(source, key):
    return _numeric(source[key]) if key in source else None


def _percent(passes, failures, errors):
    total = sum(_number(value) for value in (passes, failures, errors))
    if not total:
        return "--"
    return f"{math.floor(_number(passes) / total * 100 + 0.5)}%"


def _cases_by_name(items):
    def case_name(item):
        if "case" not in item:
            return "undefined"
        value = item["case"]
        if value is None:
            return "null"
        if isinstance(value, bool):
            return str(value).lower()
        return str(value)

    return {case_name(_obj(item)): _obj(item) for item in _list(items)}


def _href(value):
    return quote(str(value), safe="-_.!~*'()")


def _target(run_root, target):
    target_id = target["id"]
    target_root = Path(_fallback(target.get("targetRoot"), str(Path(run_root) / target_id)))
    summary = _fallback(target.get("summary"), _read_json(target_root / "summary.json"))
    report = _fallback(target.get("report"), _read_json(target_root / "report.json"))
    environment = _read_json(target_root / "environment.json")
    summary, report, environment = map(_obj, (summary, report, environment))
    agent_report = _obj(report.get("agent"))
    ohos_report = _obj(report.get("ohosTest"))
    whitebox_report = _obj(report.get("whitebox"))
    model = _obj(environment.get("generationModel"))
    error = str(target.get("error") or "")
    agent_cases = _cases_by_name(agent_report.get("cases"))
    test_cases = _cases_by_name(ohos_report.get("caseResults"))
    whitebox_cases = _cases_by_name(whitebox_report.get("cases"))
    result_cases = _cases_by_name(summary.get("results"))
    case_names = dict.fromkeys((*agent_cases, *test_cases, *whitebox_cases, *result_cases))
    cases = {}
    for case_name in case_names:
        agent = agent_cases.get(case_name, {})
        test = test_cases.get(case_name, {})
        whitebox = whitebox_cases.get(case_name, {})
        result = result_cases.get(case_name, {})
        run = _obj(test.get("run"))
        totals = {key: sum(_number(_obj(device).get(key)) for device in _list(run.get("devices")))
                  for key in ("passes", "failures", "errors")}
        cases[case_name] = {
            "status": str(_fallback(result.get("status"), agent.get("status"), test.get("status"), "unknown")),
            "elapsedSec": _number(_fallback(result.get("elapsedSec"), agent.get("elapsedSec"))),
            "tokenTotal": _number(_fallback(_obj(result.get("tokenUsage")).get("total"),
                                            _obj(agent.get("tokenUsage")).get("total"))),
            "modelCalls": _number(agent.get("modelCalls")),
            "toolCalls": _number(agent.get("toolCalls")),
            "tests": {"status": str(test.get("status") or ""), **totals,
                      "passRate": _percent(totals["passes"], totals["failures"], totals["errors"])},
            "whiteboxScore": _score(whitebox, "totalScore"),
            "detailHref": f"{_href(target_id)}/subpage/{_href(case_name + '.html')}",
        }
    return {
        "id": target_id, "label": _fallback(target.get("label"), target_id),
        "mode": _fallback(target.get("mode"), summary.get("opencodeSourceMode"), ""),
        "agent": _fallback(summary.get("agent"), agent_report.get("type"), target.get("agent"), ""),
        "status": "failed" if error else _fallback(summary.get("status"), "failed"),
        "error": error,
        "providerId": _fallback(summary.get("providerId"), agent_report.get("providerId"), model.get("providerId"), ""),
        "modelId": _fallback(summary.get("modelId"), agent_report.get("modelId"), model.get("modelId"), ""),
        "modelConfigFingerprint": _fallback(model.get("configFingerprint"), ""),
        "summary": {
            **{key: _number(summary.get(key)) for key in ("total", "completed", "failed")},
            "tokenTotal": _number(_fallback(_obj(summary.get("tokenUsage")).get("total"), agent_report.get("totalTokens"))),
            "modelCalls": _number(agent_report.get("modelCalls")),
            "toolCalls": _number(agent_report.get("toolCalls")),
            "testsRun": _number(ohos_report.get("testsRun")),
            **{key: _number(ohos_report.get(key)) for key in ("passes", "failures", "errors")},
            "passRate": _percent(ohos_report.get("passes"), ohos_report.get("failures"), ohos_report.get("errors")),
            "whiteboxAverageScore": _score(whitebox_report, "averageScore"),
        },
        "overviewHref": f"{_href(target_id)}/overview.html", "cases": cases,
    }


def build_comparison_report(payload):
    targets = [_target(payload["runRoot"], _obj(target)) for target in _list(payload.get("targets"))]
    generation_model = _obj(payload.get("generationModel"))
    fingerprints = {target["modelConfigFingerprint"] for target in targets if target["modelConfigFingerprint"]}
    same_model = all(target["providerId"] == generation_model.get("providerId")
                     and target["modelId"] == generation_model.get("modelId") for target in targets)
    return {"schemaVersion": "autorun-agent-comparison-v1", "runId": payload["runId"],
            "generatedAt": payload["generatedAt"], "generationModel": payload["generationModel"],
            "sameModelValidated": same_model and len(fingerprints) <= 1,
            "targetCount": len(targets), "targets": targets}
