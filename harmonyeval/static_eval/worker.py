"""Isolated wheel APIs. Credentials arrive through stdin, never command arguments."""

import json
from pathlib import Path
import sys
from harmonyeval.utils.encoding import configure_console
from harmonyeval.utils.io import write_json
from harmonyeval.utils.security import redact


def scrub(value, secret):
    value = redact(value)
    if isinstance(value, dict):
        return {k: scrub(v, secret) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v, secret) for v in value]
    if isinstance(value, str) and secret:
        return value.replace(secret, "[redacted]")
    return value


def quality(skill, model, output):
    from core.skill_quality_eval import evaluate_skill_quality
    from core.quality_agent_judge import AgentJudgeOptions
    from llm.model_config import ModelSpec
    from viewers.quality_viewer import generate_quality_html, generate_quality_markdown
    spec = ModelSpec(base_url=model["base_url"], api_key=model["api_key"], model_name=model["name"],
                     max_context_token=model.get("max_context_tokens", 128000),
                     headers=model.get("headers", {}), extra_fields={
                         "max_tokens": model.get("max_tokens", 8192), "temperature": 0})
    # Remain a static LLM assessment: do not launch another Agent on overflow.
    report = evaluate_skill_quality(Path(skill), spec, agent_judge_options=AgentJudgeOptions(mode="degraded"))
    report = scrub(report, model["api_key"])
    write_json(output / "quality_eval.json", report)
    (output / "quality_eval.md").write_text(generate_quality_markdown(report), encoding="utf-8")
    (output / "quality_eval.html").write_text(generate_quality_html(report), encoding="utf-8")
    from harmonyeval.utils.numbers import number
    valid = report.get("total") is not None and not report.get("context_overflow")
    if valid and not (0 <= number(report["total"]) <= number(report["max"]) and number(report["max"]) > 0):
        raise ValueError("质量报告分数越界")
    return {"status": "completed" if valid else "unavailable", "report": "quality_eval.json",
            "html": "quality_eval.html", "error": report.get("error", ""),
            "metrics": {key: report.get(key) for key in ("total", "max", "percent", "grade")} if valid else {}}


def security(skill, model, output):
    from skill_scanner.engine import LocalScanConfig, run_skill_scan
    from skill_scanner.core.reporters.html_reporter import HTMLReporter
    from skill_scanner.core.reporters.markdown_reporter import MarkdownReporter
    result = run_skill_scan(LocalScanConfig(
        target_path=skill, use_llm=True, llm_provider="openai", llm_model=model["name"],
        llm_api_key=model["api_key"], llm_base_url=model["base_url"], llm_headers=model.get("headers"),
        llm_max_tokens=model.get("max_tokens", 8192), llm_timeout=model.get("timeout", 120),
        llm_max_concurrency=1))
    report = scrub(result.to_dict(), model["api_key"])
    write_json(output / "security_scan.json", report)
    (output / "security_scan.md").write_text(scrub(MarkdownReporter().generate_report(result), model["api_key"]), encoding="utf-8")
    (output / "security_scan.html").write_text(scrub(HTMLReporter().generate_report(result), model["api_key"]), encoding="utf-8")
    failures = report.get("analyzers_failed", [])
    valid = ("llm_analyzer" in report.get("analyzers_used", []) and not failures
             and not any(f.get("rule_id") == "LLM_ANALYSIS_FAILED" for f in report.get("findings", [])))
    return {"status": "completed" if valid else "unavailable", "report": "security_scan.json",
            "html": "security_scan.html", "error": str(failures) if failures else "" if valid else "未完成LLM分析",
            "metrics": {key: report.get(key) for key in ("is_safe", "max_severity", "findings_count")} if valid else {}}


def main():
    configure_console()
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    output = Path(request["output"])
    output.mkdir(parents=True, exist_ok=True)
    secret = request["model"]["api_key"]
    try:
        result = {"quality": quality, "security": security}[request["check"]](request["skill"], request["model"], output)
    except Exception as error:
        result = {"status": "unavailable", "error": f"{type(error).__name__}: {error}"}
    write_json(output / "result.json", scrub(result, secret))
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
