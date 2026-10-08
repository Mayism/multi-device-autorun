"""Shared self-contained report markup."""

from html import escape
from pathlib import Path
import math


STATUS_META = {
    "completed": ("完成", "ok"), "passed": ("通过", "ok"), "succeeded": ("成功", "ok"),
    "failed": ("失败", "fail"), "timed_out": ("超时", "fail"), "rate_limited": ("限额", "fail"),
    "interrupted": ("中断", "warn"), "cancelled": ("取消", "muted"), "skipped": ("跳过", "muted"),
    "running": ("运行中", "warn"), "pending": ("等待", "muted"), "queued": ("排队", "muted"),
    "not_started": ("--", "muted"),
}


def esc(value):
    return escape("" if value is None else str(value), quote=True).replace("&#x27;", "&#39;")


# Agent 来源分类（值与批次分层目录名一致）：
#   harmonyBot          → 自研：使用 HarmonyOS Dev Assistant 插件
#   softwareEngineering → 软工：software-multi-device，opencode 来源含 Skills
#   baseModel           → 裸模：software-multi-device，opencode 来源无 Skills
AGENT_SOURCE_LABELS = {"harmonyBot": "自研", "softwareEngineering": "软工", "baseModel": "裸模"}


def agent_source_label(mode):
    return AGENT_SOURCE_LABELS.get(str(mode or "").strip(), "")


def agent_display_name(agent, mode):
    """展示为「agent名称/（自研｜软工｜裸模）」；分类未知时仅展示名称。"""
    name = str(agent or "").strip()
    label = agent_source_label(mode)
    return f"{name}/{label}" if name and label else name


def badge(value):
    key = str(value or "").strip().lower()
    label, css = STATUS_META.get(key, (key or "--", "muted"))
    return f'<span class="badge badge-{css}">{esc(label)}</span>'


def fmt_duration(seconds):
    try:
        value = float(seconds)
        total = max(0, math.floor(value + 0.5)) if math.isfinite(value) and value > 0 else 0
    except (TypeError, ValueError):
        total = 0
    if not total:
        return "0s"
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


def page_shell(title, body, extra_head="", extra_css=""):
    css = (Path(__file__).with_name("report.css")).read_text(encoding="utf-8")
    return (f'<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n'
            f'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
            f'<title>{esc(title)}</title>\n<style>\n{css}\n{extra_css}\n</style>\n{extra_head}\n'
            f'</head>\n<body>\n<div class="wrap">{body}</div>\n</body>\n</html>')
