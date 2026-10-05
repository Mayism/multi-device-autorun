"""Render the local whitebox report from Python using the v1 result contract."""

import json
from pathlib import Path
import re


def _record(value):
    return value if isinstance(value, dict) else {}


def _array(value):
    return value if isinstance(value, list) else []


def _js_string(value):
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, dict):
        return "[object Object]"
    if isinstance(value, list):
        return ",".join(_js_string(item) for item in value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _esc(value):
    return (_js_string(value).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;"))


def _badge(value):
    label = _js_string(value) if value is not None else "--"
    kind = ("ok" if re.search(r"满足|pass|completed|none", label, re.I) else
            "bad" if re.search(r"不满足|fail|high|error", label, re.I) else "warn")
    return f'<span class="badge {kind}">{_esc(label)}</span>'


def render_whitebox_html(result):
    result = _record(result)
    overall = _record(result.get("overall_conclusion"))
    basic = _record(result.get("basic_info"))
    score = overall.get("total_score") if overall.get("total_score") is not None else 0
    hard_gate = overall.get("hard_gate_triggered") is True
    dimensions = []
    for item in _array(result.get("dimension_results")):
        dimension = _record(item)
        dimensions.append(f'<tr><td>{_esc(dimension.get("dimension_name"))}</td><td class="num">'
                          f'{_esc(dimension.get("score"))} / {_esc(dimension.get("max_score"))}</td>'
                          f'<td>{_esc(dimension.get("comment"))}</td></tr>')
    dimension_rows = "".join(dimensions) or '<tr><td colspan="3" class="muted">暂无维度评分</td></tr>'
    rules = []
    for item in _array(result.get("rule_audit_results")):
        rule = _record(item)
        rules.append(f'<tr><td>{_esc(rule.get("rule_id"))}</td><td>{_badge(rule.get("result"))}</td>'
                     f'<td>{_esc(rule.get("rule_summary"))}</td><td>{_esc(rule.get("conclusion"))}</td></tr>')
    rule_rows = "".join(rules) or '<tr><td colspan="4" class="muted">没有规则审计结果</td></tr>'
    risks = []
    for item in _array(result.get("risks")):
        risk = _record(item)
        title = risk.get("title") if risk.get("title") is not None else risk.get("risk_code")
        detail = risk.get("description") if risk.get("description") is not None else risk.get("evidence")
        risks.append(f'<li><div>{_badge(risk.get("level"))} <b>{_esc(title)}</b></div>'
                     f'<div class="muted">{_esc(detail)}</div></li>')
    risk_html = "<ul>" + "".join(risks) + "</ul>" if risks else '<p class="muted">未发现风险</p>'
    issues = "".join(f'<li>{_esc(item if isinstance(item, str) else json.dumps(item, ensure_ascii=False, separators=(",", ":")))}</li>'
                     for item in _array(result.get("main_issues"))) or '<li class="muted">暂无</li>'
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>白盒评价报告</title><style>
body{{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f4f6fa;color:#1f2937}}.wrap{{max-width:1180px;margin:auto;padding:28px}}.hero,.card{{background:white;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin-bottom:18px}}.hero{{display:flex;justify-content:space-between;align-items:center}}.score{{font-size:44px;font-weight:750;color:#155eef}}.muted{{color:#667085}}.badge{{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px}}.ok{{background:#dcfae6;color:#067647}}.bad{{background:#fee4e2;color:#b42318}}.warn{{background:#fef0c7;color:#b54708}}table{{width:100%;border-collapse:collapse}}th,td{{padding:10px;border-bottom:1px solid #eaecf0;text-align:left;vertical-align:top}}th{{background:#f9fafb}}.num{{text-align:right}}li{{margin:10px 0}}h1,h2{{margin-top:0}}</style></head>
<body><main class="wrap"><section class="hero"><div><h1>白盒评价报告</h1><div class="muted">{_esc(basic.get("target_description") if basic.get("target_description") is not None else "HarmonyOS 生成工程评分")}</div></div><div><div class="score">{_esc(score)}</div><div>{_badge("已触发硬门槛" if hard_gate else "未触发硬门槛")}</div></div></section>
<section class="card"><h2>总体结论</h2><p>{_esc(overall.get("summary"))}</p><div class="muted">任务类型：{_esc(basic.get("task_type"))} · 评价模式：{_esc(basic.get("evaluation_mode"))}</div></section>
<section class="card"><h2>维度评分</h2><table><thead><tr><th>维度</th><th class="num">得分</th><th>评价</th></tr></thead><tbody>{dimension_rows}</tbody></table></section>
<section class="card"><h2>主要问题</h2><ul>{issues}</ul></section>
<section class="card"><h2>风险</h2>{risk_html}</section>
<section class="card"><h2>规则审计</h2><table><thead><tr><th>规则</th><th>结论</th><th>摘要</th><th>依据</th></tr></thead><tbody>{rule_rows}</tbody></table></section>
</main></body></html>'''


def write_whitebox_html(result, output_path):
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_whitebox_html(result), encoding="utf-8")
    return str(path)
