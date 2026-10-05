"""Fetch and render an offline AGC cloud-test report in Python."""

from datetime import datetime, timezone
from pathlib import Path

from .cloudtest import summarize_report
from .html import badge, esc, fmt_duration, page_shell


def fetch_task_report(client, task_group_id, category):
    methods = (("apps", "任务元信息", lambda: client.get_report_apps(task_group_id)),
               ("overview", "总览结果", lambda: client.get_overview_result(task_group_id)),
               ("problems", "问题明细", lambda: client.get_overview_problem(task_group_id, category)),
               ("taskList", "设备用例矩阵", lambda: client.get_report_task_list(task_group_id, category)),
               ("titles", "表头配置", lambda: client.get_dev_report_title(task_group_id, category)))
    report = {"errors": []}
    for key, label, call in methods:
        try:
            report[key] = call()
        except Exception as error:
            report[key] = None
            report["errors"].append(f"{label}: {error}")
    return report


def _stat(label, value):
    return f'<div class="stat"><div class="k">{esc(label)}</div><div class="v">{value}</div></div>'


def _card(title, rows):
    markup = "".join(f'<div class="row"><span class="k">{esc(label)}</span><span>{esc(value)}</span></div>'
                     for label, value in rows if value is not None and value != "")
    return f'<h2>{esc(title)}</h2><div class="card" style="padding:16px 18px"><div class="kv">{markup}</div></div>' if markup else ""


def _result_cell(item):
    if not item:
        return '<span class="badge badge-muted">-</span>'
    status = str(item.get("resultStatus") or "").upper()
    if status == "PASS":
        return '<span class="badge badge-ok">PASS</span>'
    if status == "FAIL":
        return f'<span class="badge badge-error" title="未通过规则: {esc(item.get("ruleNums") or "")}">FAIL</span>'
    return '<span class="badge badge-muted">NO_VALUE</span>'


def _matrix(task_list, titles):
    if not task_list:
        return ""
    columns = []
    seen = set()
    for group in titles or []:
        for child in group.get("children") or []:
            prop = child.get("prop")
            if prop and prop not in seen and child.get("slot") not in ("device", "operation"):
                seen.add(prop)
                columns.append((prop, child.get("label") or prop))
    for task in task_list:
        for item in task.get("useCaseResultList") or []:
            prop = item.get("useCase")
            if prop and prop not in seen:
                seen.add(prop)
                columns.append((prop, prop))
    if not columns:
        return ""
    head = "".join(f"<th>{esc(label)}</th>" for _, label in columns)
    rows = []
    for task in task_list:
        device = task.get("deviceInfo") or {}
        name = device.get("displayName") or device.get("typeAlias") or device.get("model") or "?"
        by_case = {item.get("useCase"): item for item in task.get("useCaseResultList") or []}
        cells = "".join(f"<td>{_result_cell(by_case.get(prop))}</td>" for prop, _ in columns)
        rows.append(f"<tr><td>{esc(name)}</td>{cells}</tr>")
    return (f'<h2>设备 × 用例结果矩阵</h2><div class="card tbl-wrap"><table><thead><tr><th>设备</th>{head}'
            f'</tr></thead><tbody>{"".join(rows)}</tbody></table></div>')


def _problems(items):
    if not items:
        return '<h2>问题明细</h2><div class="card"><div class="empty">无问题记录（或接口未返回数据）</div></div>'
    rows = []
    for item in items:
        rule = item.get("ruleNumber") or "-"
        rule_url = item.get("ruleUrl")
        rule_markup = (f'<a class="link" href="{esc(rule_url)}" target="_blank" rel="noopener">{esc(rule)}</a>'
                       if rule_url else esc(rule))
        devices = "；".join((error.get("deviceInfo") or {}).get("displayName") or
                           (error.get("deviceInfo") or {}).get("model") or "?"
                           for error in item.get("errorTask") or [])
        rows.append(f'<tr><td>{esc(item.get("useCaseCn") or item.get("useCase") or "-")}</td>'
                    f'<td>{rule_markup}</td><td>{esc(item.get("ruleDesc") or "")}</td>'
                    f'<td>{esc(item.get("count") or 0)}</td><td>{esc(item.get("ruleLevel") or "-")}</td>'
                    f'<td>{esc(devices)}</td></tr>')
    return (f'<h2>问题明细（{len(items)} 条）</h2><div class="card tbl-wrap"><table><thead><tr>'
            '<th>用例</th><th>规则号</th><th>规则描述</th><th>次数</th><th>等级</th><th>出错设备</th>'
            f'</tr></thead><tbody>{"".join(rows)}</tbody></table></div>')


def _devices(task_list):
    if not task_list:
        return ""
    rows = []
    for task in task_list:
        device = task.get("deviceInfo") or {}
        values = (device.get("displayName") or device.get("typeAlias") or device.get("model") or "?",
                  device.get("model") or "-", device.get("osVersion") or device.get("harmonyVersion") or "-",
                  f"API {device['openHarmonySdk']}" if device.get("openHarmonySdk") else "-",
                  device.get("resolution") or "-", task.get("timeSpan") or "-",
                  {1: "待执行", 2: "执行中", 3: "已完成"}.get(task.get("executedStatus"), task.get("executedStatus") or "-"),
                  {1: "通过", 2: "失败"}.get(task.get("resultStatus"), task.get("resultStatus") or "-"),
                  task.get("sysErrorMessageCn") or task.get("connectMessageCn") or "")
        rows.append("<tr>" + "".join(f"<td>{esc(value)}</td>" for value in values) + "</tr>")
    return ('<h2>设备执行明细</h2><div class="card tbl-wrap"><table><thead><tr>'
            '<th>设备</th><th>型号</th><th>系统版本</th><th>API</th><th>分辨率</th><th>用时</th>'
            '<th>执行状态</th><th>结果</th><th>错误信息</th></tr></thead><tbody>' + "".join(rows) + '</tbody></table></div>')


def write_cloudtest_html_report(result, report, out_dir):
    report = report or {}
    task = result.get("task") or {}
    group = (result.get("polling") or {}).get("taskGroup") or {}
    app = result.get("app") or {}
    apps = (report.get("apps") or [{}])[0] or {}
    app_info = apps.get("appInfo") or {}
    summary = summarize_report(report)
    overview = report.get("overview") or {}
    categories = overview.get("categoryResults") or [{}]
    rules = (categories[0] or {}).get("ruleInfo") or {}
    stats = (("状态", badge(result.get("status"))),
             ("进度", esc(f"{group.get('processedTestTaskCount') or 0}/{group.get('taskCount') or '?'}")),
             ("通过规则", esc(rules.get("passedErrorCount", summary["rulePassed"]))),
             ("失败规则", esc(rules.get("failedErrorCount", summary["ruleFailed"]))),
             ("设备通过/失败", esc(f"{summary['devicePassed']}/{summary['deviceFailed']}")),
             ("问题数量", esc(summary["issueCount"])),
             ("测试设备", esc(len(report.get("taskList") or []))),
             ("云端执行耗时", esc(fmt_duration(apps.get("executeTime") or result.get("elapsedSec")))))
    body = (f'<h1>云测试报告 · {esc(task.get("taskName") or group.get("taskGroupName") or "未命名任务")}</h1>'
            f'<p class="sub">任务组 <code>{esc(task.get("taskGroupId") or group.get("id") or "-")}</code></p>'
            '<h2>结果总览</h2><div class="stats">' + "".join(_stat(label, value) for label, value in stats) + '</div>'
            + _card("应用信息", (("应用名称", (result.get("upload") or {}).get("appName") or app_info.get("appName") or "-"),
                              ("版本", app_info.get("version") or app.get("versionName") or "-"),
                              ("包名", app_info.get("packageName") or app.get("bundleName") or "-"),
                              ("签名包", app.get("fileName") or "")))
            + _matrix(report.get("taskList"), report.get("titles"))
            + _problems(report.get("problems")) + _devices(report.get("taskList")))
    if report.get("errors"):
        body += _card("报告数据缺口", (("接口错误", "；".join(report["errors"])),))
    output = Path(out_dir) / "cloudtest-report.html"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(page_shell("云测试报告", body), encoding="utf-8")
    return str(output)
