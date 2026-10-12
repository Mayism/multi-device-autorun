"""Offline batch, target-comparison and historical-overview reports."""

from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from pyautorun.reporting.batch_report import build_batch_report
from pyautorun.orchestration.batch_state import read_json
from pyautorun.orchestration.case_run import write_json
from pyautorun.reporting.comparison_report import build_comparison_report
from pyautorun.reporting.html import badge, esc, fmt_duration, page_shell


def _iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _link(path, label):
    if not path:
        return "--"
    return f'<a class="link" href="{esc(path)}">{esc(label)}</a>'


def _case_page(result):
    name = result.get("case") or ""
    logs = result.get("logs") or {}
    rows = []
    for label, key in (("Agent 输出", "outputPath"), ("工程差异", "patchPath")):
        value = result.get(key) or ""
        if value:
            rows.append(f"<tr><th>{esc(label)}</th><td>{_link(Path(value).as_uri(), Path(value).name)}</td></tr>")
    for label, key in (("Agent 会话", "transcriptPath"), ("模型消息", "messagesPath"),
                       ("编译记录", "compileAttemptsPath")):
        value = logs.get(key) or ""
        if value:
            rows.append(f"<tr><th>{esc(label)}</th><td>{_link(Path(value).as_uri(), Path(value).name)}</td></tr>")
    ohos = result.get("ohosTest") or {}
    cloud = result.get("cloudTest") or {}
    whitebox = result.get("whitebox") or {}
    sections = [f"<h1>{esc(name)}</h1>",
                f'<p>{badge(result.get("status"))} · Agent {badge(result.get("agentStatus"))} '
                f'· 耗时 {fmt_duration(result.get("elapsedSec"))}</p>',
                f'<p class="muted">{esc(result.get("providerId"))}/{esc(result.get("modelId"))}</p>']
    if result.get("error"):
        sections.append(f'<div class="card fail">{esc(result["error"])}</div>')
    if rows:
        sections.append('<h2>执行产物</h2><div class="card tbl-wrap"><table>' + "".join(rows) + "</table></div>")
    verifications = result.get("verifications") or {}
    display = [(identifier, detail) for identifier, detail in verifications.items()] if verifications else [
        ("ohosTest", ohos), ("云测试", cloud), ("白盒评价", whitebox)]
    for title, detail in display:
        if not detail:
            continue
        sections.append(f'<h2>{title}</h2><div class="card">{badge(detail.get("status"))} '
                        f'{esc(detail.get("error") or "")}</div>')
        original = detail.get("details") or detail
        report_path = detail.get("reportPath") or original.get("resultPath") or ""
        if report_path and Path(report_path).is_file():
            sections.append(_link(Path(report_path).as_uri(), "查看原始报告"))
        if title in ("云测试", "CloudTest") and original.get("outputDir"):
            report = Path(original["outputDir"]) / "cloudtest-report.html"
            if report.is_file():
                sections.append(_link(report.as_uri(), "查看云测试报告"))
        if title in ("白盒评价", "Whitebox") and original.get("outputDir"):
            sections.append(f'<p class="muted">评分：{esc(original.get("totalScore", "--"))}</p>')
    if result.get("scoring"):
        scores = []
        for dimension, item in result["scoring"].items():
            score = item.get("score") if item.get("status") == "scored" else "--"
            source = item.get("sourceReport") or ""
            source_link = _link(Path(source).as_uri(), "原始报告") if source and Path(source).is_file() else "--"
            scores.append(f"<tr><td>{esc(dimension)}</td><td>{esc(item.get('rule'))}</td>"
                          f"<td>{esc(score)}</td><td>{esc(item.get('status'))}</td><td>{source_link}</td></tr>")
        sections.append('<h2>评估评分</h2><div class="card tbl-wrap"><table><thead><tr>'
                        '<th>维度</th><th>规则</th><th>得分</th><th>状态</th><th>报告</th>'
                        '</tr></thead><tbody>' + "".join(scores) + '</tbody></table></div>')
    if result.get("output"):
        sections.append(f'<h2>Agent 最终回复</h2><pre class="card">{esc(result["output"])}</pre>')
    return page_shell(f"Autorun · {name}", "\n".join(sections))


def write_batch_report(batch_root, summary, upload_config=None, on_log=lambda _message: None):
    root = Path(batch_root)
    report = build_batch_report({"summary": summary, "generatedAt": _iso()})
    json_path = root / "report.json"
    write_json(json_path, report)
    from .upload import archive_and_upload
    try:
        archive_and_upload(root, summary, report, upload_config, on_log)
    except Exception as error:
        on_log(f"批量打包/上传失败: {error}")
    subpage = root / "subpage"
    subpage.mkdir(parents=True, exist_ok=True)
    rows = []
    has_scoring = bool((summary.get("harmonyEval") or {}).get("scores"))
    verification_ids = list((summary.get("verifications") or {}).keys())
    if not verification_ids:
        verification_ids = ["ohosTest", "cloudTest", "whitebox"]
    for result in summary.get("results") or []:
        name = str(result.get("case") or "")
        filename = name + ".html"
        (subpage / filename).write_text(_case_page(result), encoding="utf-8")
        href = "subpage/" + quote(filename)
        case_scores = result.get("scoring") or {}
        score_text = ", ".join(f"{key}: {value['score']:.3f}" if value.get("status") == "scored"
                               else f"{key}: --" for key, value in case_scores.items())
        verification_cells = []
        for identifier in verification_ids:
            detail = (result.get("verifications") or {}).get(identifier) or result.get(identifier) or {}
            verification_cells.append(f'<td>{badge(detail.get("status"))}</td>')
        rows.append(f'<tr><td><a class="link" href="{esc(href)}">{esc(name)}</a></td>'
                    f'<td>{badge(result.get("agentStatus") or result.get("status"))}</td>'
                    + ''.join(verification_cells)
                    + (f'<td>{esc(score_text)}</td>' if has_scoring else '')
                    + f'<td>{fmt_duration(result.get("elapsedSec"))}</td></tr>')
    scoring_header = '<th>评分</th>' if has_scoring else ''
    scoring_summary = ''
    if has_scoring:
        items = (summary["harmonyEval"]["scores"]).items()
        lines = (f'<tr><td>{esc(name)}</td><td>{esc(value.get("rule"))}</td>'
                 f'<td>{esc(value.get("average") if value.get("average") is not None else "--")}</td>'
                 f'<td>{value.get("scored")}/{value.get("total")}</td></tr>' for name, value in items)
        scoring_summary = ('<h2>维度汇总</h2><div class="card tbl-wrap"><table><thead><tr>'
                           '<th>维度</th><th>规则</th><th>均分</th><th>有效/全部</th>'
                           '</tr></thead><tbody>' + ''.join(lines) + '</tbody></table></div>')
    body = (f'<h1>Autorun 批次报告</h1><p class="muted">{esc(summary.get("batchId"))} · '
            f'{esc(summary.get("targetId"))}</p><div class="stats">'
            f'<div class="stat"><div class="k">状态</div><div class="v">{badge(summary.get("status"))}</div></div>'
            f'<div class="stat"><div class="k">完成</div><div class="v">{summary.get("completed", 0)}/{summary.get("total", 0)}</div></div>'
            f'<div class="stat"><div class="k">失败</div><div class="v">{summary.get("failed", 0)}</div></div>'
            f'<div class="stat"><div class="k">Token</div><div class="v">{(summary.get("tokenUsage") or {}).get("total", 0)}</div></div>'
            '</div><h2>用例</h2><div class="card tbl-wrap"><table><thead><tr>'
            '<th>用例</th><th>Agent</th>'
            + ''.join(f'<th>{esc(identifier)}</th>' for identifier in verification_ids)
            + scoring_header + '<th>耗时</th>'
            + '</tr></thead><tbody>' + "".join(rows) + '</tbody></table></div>' + scoring_summary)
    overview = root / "overview.html"
    overview.write_text(page_shell("Autorun 批次报告", body), encoding="utf-8")
    return {"jsonPath": str(json_path), "htmlOverviewPath": str(overview), "htmlError": ""}


def write_comparison_report(run_root, run_id, generation_model, targets):
    root = Path(run_root)
    data = build_comparison_report({"runRoot": str(root), "runId": run_id,
                                    "generationModel": generation_model, "targets": targets,
                                    "generatedAt": _iso()})
    comparison_path = root / "comparison.json"
    if len(data["targets"]) > 1:
        write_json(comparison_path, data)
    cases = sorted({case for target in data["targets"] for case in target["cases"]})
    headers = "".join(f"<th>{esc(target['label'])}</th>" for target in data["targets"])
    rows = []
    for name in cases:
        cells = []
        for target in data["targets"]:
            item = target["cases"].get(name)
            if not item:
                cells.append('<td class="empty">--</td>')
            else:
                cells.append(f'<td><a class="link" href="{esc(item["detailHref"])}">'
                             f'{badge(item["status"])}</a><div class="muted">'
                             f'UI {esc(item["tests"]["passRate"])} · 白盒 {esc(item["whiteboxScore"] or "--")} '
                             f'· Token {esc(item["tokenTotal"])}</div></td>')
        rows.append(f'<tr><td>{esc(name)}</td>{"".join(cells)}</tr>')
    cards = "".join(f'<div class="stat"><div class="k">{esc(target["label"])}</div>'
                    f'<div class="v">{badge(target["status"])}</div>'
                    f'<div class="muted">完成 {target["summary"]["completed"]}/{target["summary"]["total"]}</div>'
                    f'{_link(target["overviewHref"], "查看 Agent 报告")}</div>' for target in data["targets"])
    body = (f'<h1>Autorun 执行总览</h1><p class="muted">{esc(run_id)} · '
            f'{esc(generation_model.get("providerId"))}/{esc(generation_model.get("modelId"))}</p>'
            f'<div class="stats">{cards}</div><h2>用例</h2><div class="card tbl-wrap"><table>'
            f'<thead><tr><th>用例</th>{headers}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>')
    overview = root / "overview.html"
    overview.write_text(page_shell("Autorun 执行总览", body), encoding="utf-8")
    return {"overviewPath": str(overview), "comparisonPath": str(comparison_path) if len(data["targets"]) > 1 else "",
            "comparison": data}


def merge_overview(output_root):
    root = Path(output_root)
    if not root.is_dir():
        raise ValueError(f"输出目录不存在: {root}")
    batches = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        candidates = [entry] if (entry / "summary.json").is_file() else [
            child for child in entry.iterdir() if child.is_dir() and (child / "summary.json").is_file()]
        for candidate in candidates:
            summary = read_json(candidate / "summary.json")
            if summary:
                batches.append((candidate, summary))
    batches.sort(key=lambda item: str(item[0]))
    rows = []
    for directory, summary in batches:
        relative = directory.relative_to(root).as_posix()
        href = quote(relative, safe="/") + "/overview.html"
        rows.append(f'<tr><td>{_link(href, summary.get("batchId") or relative)}</td>'
                    f'<td>{esc(summary.get("targetId") or "")}</td><td>{badge(summary.get("status"))}</td>'
                    f'<td>{summary.get("completed", 0)}/{summary.get("total", 0)}</td>'
                    f'<td>{summary.get("failed", 0)}</td></tr>')
    body = ('<h1>Autorun 历史批次</h1><div class="card tbl-wrap"><table><thead><tr>'
            '<th>批次</th><th>Agent</th><th>状态</th><th>完成</th><th>失败</th>'
            '</tr></thead><tbody>' + "".join(rows) + '</tbody></table></div>')
    overview = root / "overview.html"
    overview.write_text(page_shell("Autorun 历史批次", body), encoding="utf-8")
    return {"batchCount": len(batches), "overviewPath": str(overview)}
