"""L1 评分报告（内容模块）。

只负责 L1 口径的评分计算、数据读取与章节内容产出；单页骨架（左侧菜单、
面板容器、锚点路由、滚动联动）由 overview_report 提供，通过菜单项
{id, label, group, html} 接入。其他菜单报告（如 S-001 静态质量）接入
总览时同样只需要产出自己的章节 HTML。

L1 评分口径（功能级）：
  构建完成 = 本条用例工程编译成功（runner runs.swe.build.status === "passed"）
  功能完成 = 本条用例全部测试通过（所有设备 passed 且无失败/错误且实际执行了用例）
  L1 评分  = 构建完成与功能完成同时满足得 100 分，否则 0 分
"""

from datetime import datetime, timezone
import json
import math
from pathlib import Path

from pyautorun.orchestration.batch_state import read_json
from pyautorun.orchestration.case_run import safe_name
from pyautorun.reporting.html import agent_display_name, esc
from pyautorun.reporting.overview_report import write_overview_report


L1_SCORE_PASS = 100
L1_SCORE_FAIL = 0

L1_AGGREGATE_ANCHOR = "l1-aggregate"
L1_STATIC_ANCHOR = "s-001-static"

# 列顺序固定为「不带skill → 带skill」，与 L1 报告口径一致，不受配置目标顺序影响。
L1_COLUMN_ORDER = {"softwareEngineering": 0, "baseModel": 0, "harmonyBot": 1}


def _obj(value):
    return value if isinstance(value, dict) else {}


def _text(value):
    return "" if value is None else str(value)


def _num(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0
    return round(parsed) if math.isfinite(parsed) and parsed > 0 else 0


def _read_json(file_path):
    if not file_path:
        return None
    try:
        return json.loads(Path(file_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def compute_l1_verdict(build=None, devices=None):
    """L1 判定：构建完成 + 功能完成（全部设备通过且有实际执行用例）→ 100 分。"""
    devices = devices if isinstance(devices, list) else []
    build_complete = _text(_obj(build).get("status")).strip() == "passed"
    totals = {"devices": 0, "testsRun": 0, "passes": 0, "failures": 0, "errors": 0}
    for device in devices:
        device = _obj(device)
        totals["devices"] += 1
        for key in ("testsRun", "passes", "failures", "errors"):
            totals[key] += _num(device.get(key))
    all_devices_passed = totals["devices"] > 0 and all(
        _text(_obj(device).get("status")).strip() == "passed" for device in devices)
    function_complete = (all_devices_passed and totals["failures"] == 0
                         and totals["errors"] == 0 and totals["testsRun"] > 0)
    return {"buildComplete": build_complete, "functionComplete": function_complete,
            "totals": totals,
            "score": L1_SCORE_PASS if build_complete and function_complete else L1_SCORE_FAIL}


def l1_column_label(target):
    """列标题与配置来源对齐：软工/裸模 → 不带skill；自研插件 → 带skill。"""
    mode = _text(target.get("mode") or target.get("opencodeSourceMode")).strip()
    if mode == "harmonyBot":
        return "带skill"
    if mode in ("softwareEngineering", "baseModel"):
        return "不带skill"
    return _text(target.get("label") or target.get("id")).strip() or "Agent"


def load_l1_target(run_root, target):
    target_root = target.get("targetRoot") or str(Path(run_root) / _text(target.get("id")))
    summary = target.get("summary") or _read_json(Path(target_root) / "summary.json")
    report = _read_json(Path(target_root) / "report.json")
    environment = (target.get("environment") or _obj(summary).get("environment")
                   or _read_json(Path(target_root) / "environment.json"))
    mode = _text(target.get("mode") or _obj(summary).get("opencodeSourceMode")).strip()
    test_cases = {item.get("case"): item for item in
                  _obj(_obj(report).get("ohosTest")).get("caseResults", [])
                  if isinstance(item, dict) and item.get("case")}
    result_cases = {item.get("case"): item for item in
                    _obj(summary).get("results", []) if isinstance(item, dict) and item.get("case")}
    cases = {}
    for case_name in sorted({*test_cases.keys(), *result_cases.keys()}):
        if not case_name:
            continue
        test = test_cases.get(case_name)
        result = result_cases.get(case_name)
        runner_result = _read_json(_obj(test).get("sourceResultPath"))
        run = _obj(_obj(test).get("run"))
        verdict = compute_l1_verdict(run.get("build"), run.get("devices"))
        cases[case_name] = {
            "present": bool(test or result),
            "caseStatus": _text(_obj(result).get("status") or _obj(test).get("status") or "unknown") or "unknown",
            "ohosTestStatus": _text(_obj(test).get("status")),
            "runnerOutputAvailable": bool(_obj(test).get("runnerOutputAvailable")),
            "metadataCaseId": _text(_obj(runner_result).get("caseId")).strip(),
            "buildDurationSec": _num(_obj(run.get("build")).get("durationSec")),
            "error": "；".join(item for item in (_text(_obj(result).get("error")),
                                                _text(_obj(test).get("error"))) if item),
            **verdict,
        }
    generation = _obj(_obj(environment).get("generationModel"))
    skills = _obj(_obj(environment).get("skills")).get("loaded")
    agent = _text(_obj(summary).get("agent") or target.get("agent") or _obj(environment).get("agent"))
    return {
        "id": _text(target.get("id")) or "target",
        "label": _text(target.get("label")) or _text(target.get("id")) or "target",
        "mode": mode,
        "agent": agent,
        "columnLabel": l1_column_label({**target, "mode": mode, "agent": agent}),
        "providerId": _text(_obj(summary).get("providerId") or generation.get("providerId")),
        "modelId": _text(_obj(summary).get("modelId") or generation.get("modelId")),
        "targetError": _text(target.get("error")),
        "skillsLoaded": [item for item in (skills if isinstance(skills, list) else [])
                         if _text(item).strip()],
        "cases": cases,
    }


def _dimension_cell(item):
    if not item or not item.get("present"):
        return '<td class="muted">未执行</td>'
    if item.get("pass"):
        return '<td><span class="l1-verdict l1-verdict-pass">通过</span></td>'
    return '<td><span class="l1-verdict l1-verdict-fail">不通过</span></td>'


def _skill_chips(skills):
    if not skills:
        return '<span class="muted">--</span>'
    chips = "".join(f'<span class="l1-chip">{esc(skill)}</span>' for skill in skills)
    return f'<span class="l1-chips">{chips}</span>'


def _index_stats_html(case_reports, targets):
    cells = []
    for target in targets:
        items = [report["targets"][target["id"]] for report in case_reports
                 if report["targets"].get(target["id"])]
        full = sum(item["score"] >= L1_SCORE_PASS for item in items)
        average = round(sum(item["score"] for item in items) / len(items)) if items else 0
        cells.append(f'<div class="stat"><div class="k">{esc(target["columnLabel"])}</div>\n'
                     f'      <div class="v">{average} 分</div>\n'
                     f'      <div class="muted">满分用例 {full}/{len(items) or 0} · 平均分</div></div>')
    return (f'<div class="stats">\n    <div class="stat"><div class="k">用例总数</div>'
            f'<div class="v">{len(case_reports)}</div></div>\n    ' + "".join(cells) + "\n  </div>")


def _comparison_cell(targets, case_by_target, key):
    """结果对比：带skill 与 不带skill 判定相同（或任一未执行）显示 -；
    带skill 通过而不带skill 不通过显示 改善，反之显示 恶化。"""
    skill = next((item for item in targets if item["mode"] == "harmonyBot"), None)
    plain = next((item for item in targets
                  if item["mode"] in ("softwareEngineering", "baseModel")), None)

    def verdict(target):
        item = case_by_target.get(target["id"]) if target else None
        if not item or not item.get("present"):
            return None
        return bool(item.get(key))

    with_skill, without_skill = verdict(skill), verdict(plain)
    if with_skill is None or without_skill is None or with_skill == without_skill:
        return "<td>-</td>"
    if with_skill:
        return '<td><span class="l1-delta l1-delta-good">改善</span></td>'
    return '<td><span class="l1-delta l1-delta-bad">恶化</span></td>'


def _l1_result_table(targets, case_by_target):
    headers = "".join(f"<th>{esc(target['columnLabel'])}</th>" for target in targets)

    def row(dimension_label, key):
        cells = ""
        for target in targets:
            item = case_by_target.get(target["id"])
            cells += _dimension_cell({"present": True, "pass": bool(item and item.get(key))}
                                     if item and item.get("present") else None)
        comparison = _comparison_cell(targets, case_by_target, key)
        return (f'<tr><td style="text-align:left;font-weight:600">{esc(dimension_label)}</td>'
                f'{cells}{comparison}</tr>')

    build_row = row("构建完成", "buildComplete")
    function_row = row("功能完成", "functionComplete")
    return ('<div class="card tbl-wrap"><table class="l1-table">\n    <thead><tr>'
            '<th style="text-align:left">二级维度</th>' + headers + '<th>结果对比</th></tr></thead>\n'
            f'    <tbody>{build_row}{function_row}</tbody>\n  </table></div>')


def _target_error_notes(targets, case_by_target):
    notes = []
    for target in targets:
        item = case_by_target.get(target["id"])
        error = (item.get("error") if item else "") or (target.get("targetError") if item and not item.get("present") else "")
        if error:
            notes.append(f'<div><span class="k">{esc(target["columnLabel"])}：</span>'
                         f'{esc(error[:500])}</div>')
    if not notes:
        return ""
    return f'<div class="card l1-notes"><div class="l1-card-title">未通过说明</div>{"".join(notes)}</div>'


def _info_card_html(case_id, case_name, info):
    def stat(label, value_html, extra_class=""):
        return (f'<div class="l1-stat {extra_class}"><div class="k">{esc(label)}</div>'
                f'<div class="v">{value_html}</div></div>')

    return f"""<h3 class="l1-h2-bar">用例信息</h3>
  <div class="l1-stats">
    {stat("用例ID", f'<span class="mono">{esc(case_id or "--")}</span>')}
    {stat("用例名称", esc(case_name))}
    {stat("评测模型", f'<span class="mono">{esc(info.get("model") or "--")}</span>')}
    {stat("AGENT框架", esc(info.get("agents") or "--"))}
    {stat("所属SKILL", _skill_chips(info.get("skills") or []), "l1-stat-wide")}
  </div>"""


def _case_section_html(case_name, case_id, info, targets, case_by_target):
    return f"""<h2>{esc(case_name)}</h2>
    {_info_card_html(case_id, case_name, info)}
    <h3 class="l1-h2-bar">结果维度 - L1 功能</h3>
    {_l1_result_table(targets, case_by_target)}
    {_target_error_notes(targets, case_by_target)}"""


def _safe_file_name(case_name):
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(case_name or ""))[:120]
    return (cleaned or "case") + ".html"


def _case_anchor_id(case_name):
    return _safe_file_name(case_name)[:-len(".html")]


# L1 章节样式：信息卡片、结果表格小字、未通过说明、SKILL 标签。
# 页面骨架样式（面板/侧栏/区块标题）由 overview_report 提供。
L1_EXTRA_HEAD = """<style>
  h3 { font-size: 15px; margin: 20px 0 10px; color: var(--text); }
  /* 章节小标题与总览的 l1-h2-bar 标题条保持一致（字号对齐 report.css 的 h2） */
  h3.l1-h2-bar { font-size: 17px; margin: 22px 0 12px; }
  /* 用例信息：独立小卡片网格 */
  .l1-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .l1-stat .k { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
  .l1-stat .v { font-size: 15px; font-weight: 600; word-break: break-all; }
  .l1-stat-wide { grid-column: 1 / -1; }
  .l1-card-title { font-size: 15px; font-weight: 650; margin-bottom: 12px; }
  .l1-notes { padding: 14px 18px; margin-top: 14px; }
  .l1-notes .k { color: var(--muted); margin-right: 6px; }
  .l1-notes > div:not(.l1-card-title) { margin-bottom: 6px; word-break: break-all; font-size: 13px; }
  /* 结果维度判定药丸：通过/不通过 通用样式 */
  .l1-verdict { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .l1-verdict-pass { color: #15803d; background: #dcfce7; }
  .l1-verdict-fail { color: #b91c1c; background: #fee2e2; }
  /* 结果维度表格斑马线（偶数数据行浅灰底，hover 高亮保持可见） */
  .l1-table tbody tr:nth-child(even) td { background: #f8fafc; }
  .l1-table tbody tr:hover td { background: #eef5ff; }
  /* 结果对比列：改善/恶化 */
  .l1-delta { font-weight: 600; }
  .l1-delta-good { color: #15803d; }
  .l1-delta-bad { color: #b91c1c; }
  .l1-chips { display: inline-flex; flex-wrap: wrap; gap: 6px; font-weight: 400; }
  .l1-chip { display: inline-block; padding: 2px 10px; border-radius: 12px; background: var(--accent-soft); color: var(--accent); font-size: 12px; }
</style>"""


def build_l1_menus(run_root, run_id, generation_model, targets):
    """生成 L1 总览的菜单章节：汇聚报告、S-001 占位（扩展点）、各用例章节。

    其他菜单报告接入总览时，仿照此结构追加 {id, label, group, html} 菜单项即可。
    """
    loaded = [load_l1_target(run_root, target) for target in (targets if isinstance(targets, list) else [])]
    loaded.sort(key=lambda item: (L1_COLUMN_ORDER.get(item["mode"], 2), item["id"]))
    case_names = sorted({name for target in loaded for name in target["cases"]})
    model_source = (generation_model if _obj(generation_model).get("providerId")
                    and _obj(generation_model).get("modelId")
                    else next((target for target in loaded
                               if target["providerId"] and target["modelId"]), {}))
    model_text = _text(f'{model_source["providerId"]}/{model_source["modelId"]}'
                       if model_source.get("providerId") and model_source.get("modelId") else "")
    agent_names = [agent_display_name(target["agent"], target["mode"]) for target in loaded]
    agents_text = "、".join(dict.fromkeys(name for name in agent_names if name))
    all_skills = sorted({skill for target in loaded for skill in target["skillsLoaded"]})
    info = {"model": model_text, "agents": agents_text, "skills": all_skills}

    case_reports = []
    case_menus = []
    for case_name in case_names:
        case_by_target = {target["id"]: target["cases"].get(case_name) for target in loaded}
        case_id = next((item["metadataCaseId"] for item in case_by_target.values()
                        if item and item.get("metadataCaseId")), None) or case_name
        anchor_id = _case_anchor_id(case_name)
        case_menus.append({"id": f"case-{anchor_id}", "label": case_name, "group": "用例报告",
                           "html": _case_section_html(case_name, case_id, info, loaded, case_by_target)})
        case_reports.append({
            "caseName": case_name, "caseId": case_id, "anchorId": anchor_id,
            "targets": {target["id"]: (None if not target["cases"].get(case_name) else {
                "present": target["cases"][case_name]["present"],
                "buildComplete": target["cases"][case_name]["buildComplete"],
                "functionComplete": target["cases"][case_name]["functionComplete"],
                "score": target["cases"][case_name]["score"]}) for target in loaded},
        })

    data = {
        "schemaVersion": "autorun-l1-report-v1",
        "runId": run_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "generationModel": {"providerId": _text(_obj(generation_model).get("providerId")),
                            "modelId": _text(_obj(generation_model).get("modelId"))},
        "scoring": {
            "buildComplete": "构建成功视为完成",
            "functionComplete": "本条用例全部测试通过视为完成",
            "rule": "构建完成与功能完成同时满足得 100 分，否则 0 分",
        },
        "skills": all_skills,
        "agents": agents_text,
        "targets": [{"id": target["id"], "label": target["label"], "mode": target["mode"],
                     "agent": target["agent"], "columnLabel": target["columnLabel"]}
                    for target in loaded],
        "cases": [{"caseName": report["caseName"], "caseId": report["caseId"],
                   "anchorId": report["anchorId"],
                   "dimensions": {target_id: {"present": bool(item and item.get("present")),
                                              "buildComplete": bool(item and item.get("buildComplete")),
                                              "functionComplete": bool(item and item.get("functionComplete")),
                                              "score": (item or {}).get("score", L1_SCORE_FAIL)}
                                  for target_id, item in report["targets"].items()}}
                  for report in case_reports],
    }

    menus = [
        {"id": L1_AGGREGATE_ANCHOR, "label": "汇聚报告", "group": "导航",
         "html": f'<h2 class="l1-h2-bar">总览</h2>{_index_stats_html(case_reports, loaded)}'},
        # 扩展点：S-001 静态质量等后续维度模块产出章节 HTML 后替换该占位内容
        {"id": L1_STATIC_ANCHOR, "label": "S-001 静态质量", "group": "导航",
         "html": '<div class="card"><div class="empty">该维度报告尚未接入，生成后将在此展示。</div></div>'},
        *case_menus,
    ]
    return {"menus": menus, "data": data}


def write_l1_reports(run_root, run_id, generation_model, targets):
    result = build_l1_menus(run_root, run_id, generation_model, targets)
    written = write_overview_report(run_root, "L1 评分报告", run_id, result["menus"],
                                    dir_name="l1-report", extra_head=L1_EXTRA_HEAD,
                                    data=result["data"], data_file_name="l1.json")
    return {**written, "data": result["data"]}


def collect_l1_report_targets(value, output_root):
    """--l1 模式：从既有批次产物定位可生成 L1 报告的目录。

    value 为空时取 outputRoot 下最新批次；也可传批次 ID（outputRoot 下）或任意目录，
    甚至是单个 Agent 目标目录（含 summary.json）。
    """
    root = Path(output_root)

    def has_summary(directory):
        return (Path(directory) / "summary.json").is_file()

    def list_target_dirs(directory):
        targets = []
        for entry in sorted(Path(directory).iterdir(), key=lambda item: item.name):
            if entry.is_dir() and has_summary(entry):
                targets.append({"id": safe_name(entry.name), "label": entry.name,
                                "targetRoot": str(entry)})
        return targets

    if value:
        candidates = [Path(value).resolve(), (root / value).resolve()]
        base = next((item for item in candidates if item.exists()), None)
        if not base:
            raise ValueError(f"--l1 目录不存在: {value}（也在 outputRoot={output_root} 下查找过）")
    else:
        batches = []
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if has_summary(entry) or list_target_dirs(entry):
                batches.append((entry, mtime))
        if not batches:
            raise ValueError(f"outputRoot 下没有可生成 L1 报告的批次: {output_root}")
        batches.sort(key=lambda item: item[1], reverse=True)
        base = batches[0][0]
    if has_summary(base):
        # 直接指向单个 Agent 目标目录（如 <批次>/<agentId>）
        return str(base.parent), [{"id": safe_name(base.name), "label": base.name,
                                   "targetRoot": str(base)}]
    targets = list_target_dirs(base)
    if not targets:
        raise ValueError(f"目录下没有包含 summary.json 的 Agent 批次子目录: {base}")
    return str(base), targets
