"""Local Python whitebox evaluation pipeline with an optional ArkAnalyzer sidecar."""

import argparse
from contextlib import nullcontext
from datetime import datetime, timezone
import json
import os
from pathlib import Path

from .whitebox_agents import run_agent
from .whitebox_build_check import agent_build_summary, remote_build_summary, run_hvigor_check
from .whitebox_case_constraints import load_case_constraints
from .whitebox_linter import (map_linter_findings, parse_linter_output, prepare_linter_workspace,
                              rule_sets, run_linter)
from .whitebox_opencode import OpenCodeServer, create_runtime, run_prompt
from .whitebox_patch import ensure_effective_patch
from .whitebox_report import write_whitebox_html
from .whitebox_report_result import build_result_json
from .whitebox_risk import load_risk_taxonomy
from .whitebox_rubric import load_rubric, rubric_snapshot
from .whitebox_rule_engine import run_rule_engine
from .whitebox_rule_merge import merge_rule_results
from .whitebox_rule_registry import resolve_enabled_pack_ids
from .whitebox_sandbox import build_sandbox
from .whitebox_schema import validate_whitebox_result
from .whitebox_score_core import load_official_linter_profiles, load_scoring_profiles
from .whitebox_score_result import compute_score_computation
from .whitebox_understanding import project_structure, read_patch_summary


def _write_json(root, relative, value):
    target = Path(root) / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _validate_input(input_data):
    if input_data.get("schemaVersion") != "whitebox-input-v1":
        raise ValueError("不支持的白盒输入版本")
    for key in ("caseId", "promptPath", "originalProjectPath", "generatedProjectPath", "outputDir"):
        if not isinstance(input_data.get(key), str) or not input_data[key].strip():
            raise ValueError(f"{key} 不能为空")
    for key in ("promptPath", "originalProjectPath", "generatedProjectPath", "patchPath"):
        if input_data.get(key) and not Path(input_data[key]).exists():
            raise ValueError(f"{key} 不存在: {input_data[key]}")


def _case_context(case_input, case_root, task_type, patch):
    return {"case_id": case_input["caseId"], "case_root": str(case_root),
            "task_type": task_type, "original_prompt_summary": case_input["promptText"],
            "original_project_path": case_input["originalProjectPath"],
            "generated_project_path": case_input["generatedProjectPath"],
            "effective_patch_path": patch}


def _agent_build(input_data):
    if input_data.get("agentBuild"):
        return input_data["agentBuild"]
    succeeded = input_data.get("buildSuccess") is True
    failed = input_data.get("buildSuccess") is False
    return {"source": "agent", "status": "success" if succeeded else "failed" if failed else "not_run",
            "finalAttemptStatus": "succeeded" if succeeded else "failed" if failed else "not_run",
            "attempts": [], "summary": {"attempts": 0, "succeeded": int(succeeded),
                                         "failed": int(failed), "interrupted": 0, "running": 0}}


def _linter_and_build(input_data, case_input, case_dir, understanding, evidence, env):
    enabled = env.get("HMOS_CODE_LINTER_ENABLED", "").lower() == "true"
    hvigor_enabled = env.get("HMOS_HVIGOR_BUILD_CHECK_ENABLED",
                              str(enabled).lower()).lower() == "true"
    sets = rule_sets(understanding.get("crossDeviceAdaptation"))
    changed = evidence["changedFiles"]
    lines = evidence["changedLineNumbersByFile"]
    tool_root = env.get("HMOS_OFFICIAL_TOOL_RUN_DIR")
    linter_dir = (Path(tool_root) / "codelinter" if tool_root else
                  Path(env["HMOS_CODE_LINTER_RUN_DIR"]) if env.get("HMOS_CODE_LINTER_RUN_DIR") else None)
    hvigor_dir = (Path(tool_root) / "hvigor" if tool_root else
                  linter_dir.parent / "hvigor" if linter_dir else None)
    workspace = None
    if enabled or hvigor_enabled:
        workspace = prepare_linter_workspace(case_input["generatedProjectPath"], case_dir,
                                             understanding.get("crossDeviceAdaptation"))["workspaceDir"]
    if not hvigor_enabled and input_data.get("agentBuild"):
        build = agent_build_summary(input_data["agentBuild"])
    elif not hvigor_enabled and isinstance(input_data.get("remoteBuildSuccess"), bool):
        build = remote_build_summary(input_data["remoteBuildSuccess"])
    else:
        build = run_hvigor_check(hvigor_enabled, workspace, changed,
                                 str(hvigor_dir) if hvigor_dir else None,
                                 int(env.get("HMOS_HVIGOR_BUILD_CHECK_TIMEOUT_MS", "300000")))
        build["buildCheckSource"] = "hvigor"
    findings = []
    rules = []
    status = "not_enabled" if not enabled else "not_installed"
    diagnostics = ("official Code Linter is disabled by HMOS_CODE_LINTER_ENABLED" if not enabled else
                   "official Code Linter run directory or entrypoint is unavailable")
    duration = 0
    if enabled and linter_dir and workspace and ((linter_dir / "bin" / "codelinter").is_file() or
                                                  (linter_dir / "index.js").is_file()):
        run = run_linter(linter_dir, workspace, int(env.get("HMOS_CODE_LINTER_TIMEOUT_MS", "120000")))
        parsed = parse_linter_output(run["stdout"], run["stderr"])
        status = ("timeout" if run["status"] == "timeout" else "success" if parsed["status"] == "parsed" else
                  "failed" if run["status"] == "failed" else "invalid_output")
        mapped = map_linter_findings(parsed["findings"], workspace, evidence["hasPatch"], changed, lines)
        if status == "success":
            findings = mapped["effectiveFindings"]
            rules = mapped["ruleResults"]
            diagnostics = None
        else:
            diagnostics = "official Code Linter status=" + status
        duration = run["durationMs"]
    summary = {"configuredRuleSets": sets, "effectiveFindingCount": len(findings),
               "runStatus": status, "durationMs": duration}
    if diagnostics:
        summary["diagnostics"] = diagnostics
    _write_json(case_dir, "intermediate/code-linter/summary.json", summary)
    _write_json(case_dir, "intermediate/code-linter/findings.effective.json", findings)
    _write_json(case_dir, "intermediate/code-linter/hvigor-summary.json", build)
    return summary, findings, rules, build


def _persist(case_dir, state, result):
    trace_runs = [value["trace"] for value in (state.get("taskUnderstandingAgentResult"),
                  state.get("rubricAgentRunnerResult"), state.get("ruleAgentRunnerResult"))
                  if isinstance(value, dict) and isinstance(value.get("trace"), dict)]
    trace = {"schemaVersion": 1, "caseId": state["caseInput"]["caseId"],
             "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
             "traceAvailable": bool(trace_runs), "runs": trace_runs,
             "summary": {"runCount": len(trace_runs),
                         "eventCount": sum(len(run["events"]) for run in trace_runs),
                         "toolEventCount": sum(sum(event["type"] == "tool" for event in run["events"])
                                               for run in trace_runs),
                         "errorCount": sum(run["status"] != "success" for run in trace_runs),
                         "attemptCount": sum(len(run["attempts"]) for run in trace_runs),
                         "totalElapsedMs": sum(run["elapsedMs"] for run in trace_runs)},
             "warnings": []}
    artifacts = {
        "inputs/rubric-scoring-payload.json": state.get("rubricScoringPayload") or {},
        "inputs/rule-agent-bootstrap-payload.json": state.get("ruleAgentBootstrapPayload") or {},
        "intermediate/task-understanding.json": state["taskUnderstanding"],
        "intermediate/rule-audit.json": state["deterministicRuleResults"],
        "intermediate/rubric-snapshot.json": state["rubricSnapshot"],
        "intermediate/agent-assisted-rule-candidates.json": state["assistedRuleCandidates"],
        "intermediate/rubric-agent-result.json": state["rubricAgentRunnerResult"],
        "intermediate/rule-agent-result.json": state["ruleAgentRunnerResult"],
        "intermediate/rule-audit-merged.json": state["mergedRuleAuditResults"],
        "intermediate/score-fusion.json": state["scoreComputation"]["scoreFusionDetails"],
        "intermediate/report-schema-version.json": {"schema_version": "v1",
                                                     "result_schema": "report_result_schema.json"},
        "outputs/result.json": result,
        "outputs/agent-trace.json": trace,
    }
    for relative, value in artifacts.items():
        _write_json(case_dir, relative, value)


def run_local_whitebox(input_data, *, repo_root=None, runtime=None, runner=run_prompt, server=None,
                       environ=None):
    _validate_input(input_data)
    repo_root = Path(repo_root) if repo_root else Path(__file__).resolve().parent.parent
    whitebox = repo_root / "src" / "whitebox"
    env = dict(os.environ if environ is None else environ)
    case_dir = Path(input_data["outputDir"]).resolve()
    case_dir.mkdir(parents=True, exist_ok=True)
    prompt = Path(input_data["promptPath"]).read_text(encoding="utf-8")
    task_type = input_data["taskType"]
    case_input = {"caseId": input_data["caseId"], "promptText": prompt,
                  "originalProjectPath": str(Path(input_data["originalProjectPath"]).resolve()),
                  "generatedProjectPath": str(Path(input_data["generatedProjectPath"]).resolve()),
                  "originalProjectProvided": True}
    if input_data.get("expectedConstraintsPath"):
        case_input["expectedConstraintsPath"] = input_data["expectedConstraintsPath"]
    patch = ensure_effective_patch({**case_input, "patchPath": input_data.get("patchPath")}, case_dir)
    case_input["patchPath"] = patch
    original_structure = project_structure(case_input["originalProjectPath"])
    workspace_structure = project_structure(case_input["generatedProjectPath"])
    patch_info = read_patch_summary(patch)
    constraints = load_case_constraints(case_input)
    sandbox = build_sandbox(case_dir, case_input["generatedProjectPath"], case_input["originalProjectPath"],
                            effective_patch_path=patch, metadata={"case_id": input_data["caseId"],
                            "prompt_text": prompt, "original_project_provided": True,
                            "patch_summary": patch_info, "project_structure": original_structure,
                            "workspace_project_structure": workspace_structure})
    if runtime is None:
        runtime = create_runtime(whitebox, port=env.get("HMOS_OPENCODE_PORT"),
                                 runtime_name="case-" + input_data["caseId"], environ=env)
        server = OpenCodeServer(runtime)
    context = server if server else nullcontext()
    with context:
        understanding_input = {"caseId": input_data["caseId"], "promptText": prompt,
                               "originalProjectPath": case_input["originalProjectPath"],
                               "generatedProjectPath": case_input["generatedProjectPath"],
                               "originalProjectProvided": True, "taskType": task_type,
                               "projectStructure": original_structure, "patchSummary": patch_info}
        understood = run_agent("understanding", understanding_input, sandbox["root"], runtime, runner)
        if understood["outcome"] != "success":
            raise RuntimeError("任务理解 Agent 输出无效: " + understood.get("failure_reason", ""))
        understanding = understood["final_answer"]
        _write_json(case_dir, "intermediate/task-understanding.json", understanding)
        _write_json(case_dir, "intermediate/case-rule-definitions.json", constraints)
        selected = resolve_enabled_pack_ids(understanding)
        rules = run_rule_engine(case_input, task_type, constraints, selected, repo_root, env)
        candidates = rules["assistedRuleCandidates"]
        case_root = Path(case_input["originalProjectPath"]).parent
        context_payload = _case_context(case_input, case_root, task_type, patch)
        bootstrap = {"case_context": context_payload, "task_understanding": understanding,
                     "assisted_rule_candidates": candidates}
        rubric = load_rubric(task_type, whitebox / "references" / "scoring")
        taxonomy = load_risk_taxonomy(whitebox / "references" / "risks" / "risk-taxonomy.yaml")
        snapshot = rubric_snapshot(rubric)
        snapshot["risk_taxonomy"] = [{key: item[key] for key in ("code", "level", "title", "description")}
                                     for item in taxonomy["entries"]]
        scoring_payload = {"case_context": context_payload, "task_understanding": understanding,
                           "rubric_summary": {key: value for key, value in snapshot.items() if key != "risk_taxonomy"},
                           "response_contract": {"output_language": "zh-CN", "json_only": True,
                                "required_top_level_fields": ["summary", "item_scores", "hard_gate_candidates",
                                                              "risks", "strengths", "main_issues"]}}
        if len(rules["evidenceSummary"]["changedFiles"]) > 20:
            scoring_payload["workspace_project_structure"] = {
                **workspace_structure,
                "topLevelEntries": workspace_structure["topLevelEntries"][:20],
                "modulePaths": workspace_structure["modulePaths"][:20],
                "implementationHints": workspace_structure["implementationHints"][:10]}
            scoring_payload["workspace_project_structure_note"] = (
                f'当前 changedFiles 共 {len(rules["evidenceSummary"]["changedFiles"])} 个。'
                "请先优先检查 effective_patch_path，再根据 patch 中出现的文件路径阅读相关 generated/ 或 original/ 上下文；"
                "必要时结合 workspace_project_structure 选择代表性目录或文件辅助理解。")
        linter_summary, findings, official_rules, build = _linter_and_build(
            input_data, case_input, case_dir, understanding, rules["evidenceSummary"], env)
        rubric_agent = run_agent("rubric", scoring_payload, sandbox["root"], runtime, runner,
                                 snapshot=snapshot, taxonomy=taxonomy)
        if rubric_agent["outcome"] != "success":
            raise RuntimeError("Rubric Agent 输出无效: " + rubric_agent.get("failure_reason", ""))
        if candidates:
            rule_agent = run_agent("rules", bootstrap, sandbox["root"], runtime, runner)
            if rule_agent["outcome"] != "success":
                raise RuntimeError("规则 Agent 输出无效: " + rule_agent.get("failure_reason", ""))
        else:
            rule_agent = {"outcome": "not_enabled"}
        merged = merge_rule_results([*rules["deterministicRuleResults"], *official_rules],
                                    candidates, rule_agent.get("final_answer"))
        computation = compute_score_computation({
            "taskType": task_type, "rubric": rubric, "rubricSnapshot": snapshot,
            "rubricScoringResult": rubric_agent["final_answer"], "rubricAgentRunStatus": "success",
            "ruleAuditResults": merged["mergedRuleAuditResults"],
            "ruleViolations": rules["ruleViolations"], "evidenceSummary": rules["evidenceSummary"],
            "caseRuleDefinitions": constraints, "hvigorBuildCheckSummary": build,
            "riskTaxonomy": taxonomy},
            load_scoring_profiles(whitebox / "references" / "rules"), load_official_linter_profiles())
        state = {"caseInput": case_input, "taskType": task_type, "taskUnderstanding": understanding,
                 "taskUnderstandingAgentResult": understood,
                 "caseRuleDefinitions": constraints, "enabledRulePacks": rules["enabledRulePacks"],
                 "deterministicRuleResults": rules["deterministicRuleResults"],
                 "assistedRuleCandidates": candidates, "ruleAgentBootstrapPayload": bootstrap,
                 "rubricSnapshot": snapshot, "rubricScoringPayload": scoring_payload,
                 "rubricAgentRunnerResult": rubric_agent, "ruleAgentRunnerResult": rule_agent,
                 "mergedRuleAuditResults": merged["mergedRuleAuditResults"],
                 "scoreComputation": computation, "officialLinterSummary": linter_summary,
                 "officialLinterFindings": findings, "officialLinterRuleResults": official_rules,
                 "hvigorBuildCheckSummary": build}
        result = build_result_json(state)
        validate_whitebox_result(result, whitebox / "references" / "scoring" / "report_result_schema.json")
        _persist(case_dir, state, result)
        report_path = case_dir / "report.html"
        write_whitebox_html(result, report_path)
        return {"status": "completed", "caseId": input_data["caseId"], "outputDir": str(case_dir),
                "resultPath": str(case_dir / "outputs" / "result.json"), "reportPath": str(report_path),
                "totalScore": computation["totalScore"],
                "hardGateTriggered": computation["hardGateTriggered"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run Python whitebox evaluation")
    parser.add_argument("--input", required=True)
    parser.add_argument("--port", type=int)
    args = parser.parse_args(argv)
    input_data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    env = dict(os.environ)
    if args.port:
        env["HMOS_OPENCODE_PORT"] = str(args.port)
    try:
        summary = run_local_whitebox(input_data, environ=env)
    except Exception as error:
        summary = {"status": "failed", "caseId": input_data.get("caseId", ""),
                   "outputDir": input_data.get("outputDir", ""), "error": str(error)}
        if input_data.get("outputDir"):
            _write_json(input_data["outputDir"], "failure.json", summary)
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
