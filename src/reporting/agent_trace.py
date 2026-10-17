"""Render OpenCode session messages as a self-contained, searchable HTML trace."""

from datetime import datetime
from html import escape
import json
import math
from pathlib import Path
from urllib.parse import quote


STATUS_LABELS = {"completed": "已完成", "failed": "失败", "timed_out": "超时",
                 "rate_limited": "限额", "interrupted": "已中断", "cancelled": "已取消"}


def _text(value):
    return value if isinstance(value, str) else "" if value is None else str(value)


def _object(value):
    return value if isinstance(value, dict) else {}


def _content(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)


def _timestamp(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else None
    except (TypeError, ValueError):
        return None


def _duration(started_at, finished_at):
    try:
        start = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
        end = datetime.fromisoformat(str(finished_at).replace("Z", "+00:00"))
        seconds = (end - start).total_seconds()
        if seconds < 0:
            return "--"
        total = math.floor(seconds + 0.5)
        hours, remaining = divmod(total, 3600)
        minutes, secs = divmod(remaining, 60)
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    except (TypeError, ValueError):
        return "--"


def _tokens(value):
    try:
        count = float(value)
        if not math.isfinite(count) or count <= 0:
            return "0k"
        thousands = count / 1000
        precision = 2 if thousands < 1 else 1 if thousands < 1000 else 0
        formatted = f"{thousands:,.{precision}f}"
        return (formatted.rstrip("0").rstrip(".") if precision else formatted) + "k"
    except (TypeError, ValueError):
        return "0k"


def normalize_agent_trace(sessions):
    trace = []
    for index, session in enumerate(sessions if isinstance(sessions, list) else []):
        if not isinstance(session, dict):
            continue
        entries = []
        if session.get("error"):
            entries.append({"kind": "error", "role": "system", "title": "Session 读取失败",
                            "body": _text(session["error"])})
        for message_index, message in enumerate(session.get("messages") or []):
            if not isinstance(message, dict):
                continue
            info = _object(message.get("info"))
            role = _text(info.get("role") or message.get("role") or "unknown")
            base = {"role": role, "messageId": _text(info.get("id") or message.get("id")),
                    "messageIndex": message_index, "time": _timestamp(_object(info.get("time")).get("created"))}
            for part_index, part in enumerate(message.get("parts") or []):
                if not isinstance(part, dict):
                    continue
                kind = _text(part.get("type") or "unknown").lower()
                if kind in ("step-start", "step-finish"):
                    continue
                entry = {**base, "partIndex": part_index, "kind": kind}
                if kind in ("text", "reasoning"):
                    entry.update(title="推理" if kind == "reasoning" else "用户消息" if role == "user" else "Agent 回复",
                                 body=_text(part.get("text")))
                elif kind == "tool":
                    state = _object(part.get("state"))
                    output = state.get("output", _object(state.get("metadata")).get("output"))
                    entry.update(title=_text(part.get("tool") or "未知工具"),
                                 status=_text(state.get("status") or "unknown"),
                                 callId=_text(part.get("callID") or part.get("callId")),
                                 start=_timestamp(_object(state.get("time")).get("start")),
                                 end=_timestamp(_object(state.get("time")).get("end")),
                                 input=_content(state["input"]) if "input" in state else "",
                                 output=_content(output) if output is not None else "",
                                 error=_content(state["error"]) if "error" in state else "")
                else:
                    entry.update(kind="patch" if kind == "patch" else "other",
                                 title="文件变更" if kind == "patch" else kind,
                                 body=_content(part))
                entries.append(entry)
        trace.append({"id": _text(session.get("sessionId")), "label": f"Session {index + 1}",
                      "entries": entries})
    return trace


_CSS = """
:root{--bg:#f5f7fa;--card:#fff;--ink:#1f2733;--muted:#6b7785;--line:#e4e8ee;--blue:#0a7cff;--red:#c73535}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.wrap{max-width:1180px;margin:auto;padding:24px 20px 64px}a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:23px;margin:14px 0 4px}.sub{color:var(--muted);margin:0 0 20px;word-break:break-all}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-bottom:18px}
.stat,.toolbar,.session,.entry{background:var(--card);border:1px solid var(--line);border-radius:9px}
.stat{padding:11px 14px}.stat b{display:block;font-size:18px;overflow-wrap:anywhere}.stat span{font-size:12px;color:var(--muted)}
.toolbar{position:sticky;top:0;z-index:2;padding:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;box-shadow:0 2px 8px #18273c0b}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);padding:7px 9px}
input{flex:1;min-width:220px}button{cursor:pointer}.count{color:var(--muted);font-size:12px;margin-left:auto}
.session{margin-top:16px;padding:14px}.session h2{font-size:16px;margin:0 0 8px}.session small{color:var(--muted);font-weight:400;margin-left:8px}
.entry{margin:8px 0;padding:10px 12px;border-left:3px solid #9db8d8}.entry.tool{border-left-color:#9b75d9}.entry.error{border-left-color:var(--red)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.title{font-weight:650}.tag{font-size:11px;border-radius:12px;background:#eef2f7;padding:2px 7px}.tag.error{background:#fdecec;color:var(--red)}
.meta{color:var(--muted);font-size:12px;margin-left:auto}.preview{color:#405064;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:3.2em;overflow:hidden}
details{margin-top:6px}summary{color:var(--blue);cursor:pointer;font-size:12px}pre{margin:8px 0 0;padding:12px;background:#f4f6f9;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,Consolas,monospace;max-height:65vh;overflow:auto}
.block-title{font-size:12px;color:var(--muted);margin-top:10px}.empty{padding:28px;text-align:center;color:var(--muted)}
@media(max-width:620px){.wrap{padding:14px 10px 40px}.toolbar{position:static}.meta{margin-left:0;width:100%}}
"""

_SCRIPT = """
(()=>{
 const sessions=JSON.parse(document.getElementById('traceData').textContent);
 const root=document.getElementById('trace'),search=document.getElementById('search'),filter=document.getElementById('filter'),count=document.getElementById('count');
 const bad=e=>e.kind==='error'||Boolean(e.error)||e.status==='error';
 const line=(tag,cls,value)=>{const el=document.createElement(tag);if(cls)el.className=cls;el.textContent=value;return el};
 const preview=e=>e.kind==='tool'?(e.error||e.output||e.input):e.body;
 const matches=(e,kind)=>kind==='all'||(kind==='error'?bad(e):kind==='other'?['patch','other'].includes(e.kind):e.kind===kind);
 function block(parent,label,value){if(!value)return;parent.append(line('div','block-title',label));parent.append(line('pre','',value))}
 function draw(){const query=search.value.trim().toLocaleLowerCase(),kind=filter.value;root.replaceChildren();let shown=0,errors=[];
  for(const session of sessions){const section=line('section','session','');const heading=line('h2','',session.label);heading.append(line('small','',session.id));section.append(heading);let local=0;
   for(const e of session.entries){if(!matches(e,kind))continue;const searchable=[e.title,e.body,e.input,e.output,e.error,e.messageId,e.callId].join(' ').toLocaleLowerCase();if(query&&!searchable.includes(query))continue;
    const isBad=bad(e),card=line('article','entry '+(isBad?'error':e.kind),'');const header=line('div','row','');header.append(line('span','title',e.title));header.append(line('span','tag'+(isBad?' error':''),e.kind==='tool'?e.status:e.role));
    const when=e.start||e.time,duration=e.start&&e.end?' · '+Math.max(0,e.end-e.start)+' ms':'';header.append(line('span','meta',(when?new Date(when).toLocaleString():'时间未知')+duration));card.append(header);
    const snippet=preview(e)||'';if(snippet)card.append(line('div','preview',snippet.slice(0,240)));
    const details=document.createElement('details');details.append(line('summary','','查看完整内容'));
    details.addEventListener('toggle',()=>{if(!details.open||details.dataset.loaded)return;block(details,'消息 '+(e.messageId||''),e.body);block(details,'工具输入',e.input);block(details,'工具输出',e.output);block(details,'错误',e.error);details.dataset.loaded='1'});
    if(e.body||e.input||e.output||e.error)card.append(details);section.append(card);shown++;local++;if(isBad)errors.push(card);
   }if(local)root.append(section)
  }if(!shown)root.append(line('div','empty','没有匹配的记录'));count.textContent='显示 '+shown+' 条';window.__traceErrors=errors;
 }
 let timer;search.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(draw,150)});filter.addEventListener('change',draw);
 document.getElementById('nextError').addEventListener('click',()=>{if(!(window.__traceErrors||[]).length){search.value='';filter.value='error';draw()}const items=window.__traceErrors||[];if(!items.length)return;const next=items.find(item=>item.getBoundingClientRect().top>90)||items[0];next.scrollIntoView({behavior:'smooth',block:'center'})});draw();
})();
"""


def render_agent_trace(sessions, *, case_name="", agent_status="", agent_error="", model="",
                       started_at="", finished_at="", token_usage=None):
    trace = normalize_agent_trace(sessions)
    if agent_error:
        if not trace:
            trace.append({"id": "", "label": "Session 1", "entries": []})
        trace[-1]["entries"].append({"kind": "error", "role": "system", "title": "Agent 执行错误",
                                      "body": _text(agent_error)})
    entries = [entry for session in trace for entry in session["entries"]]
    tools = sum(entry["kind"] == "tool" for entry in entries)
    errors = sum(bool(entry["kind"] == "error" or entry.get("error") or entry.get("status") == "error")
                 for entry in entries)
    data = json.dumps(trace, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e")
    data = data.replace("&", "\\u0026").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    safe = lambda value: escape(_text(value), quote=True)
    stats = (("Agent 状态", STATUS_LABELS.get(agent_status, agent_status or "未知")),
             ("Agent 耗时", _duration(started_at, finished_at)), ("Session", len(trace)),
             ("工具调用", tools), ("错误", errors), ("总 Token", _tokens((token_usage or {}).get("total"))))
    cards = "".join(f'<div class="stat"><span>{safe(label)}</span><b>{safe(value)}</b></div>'
                    for label, value in stats)
    back = "../../subpage/" + quote(case_name) + ".html"
    return (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'">'
            f'<title>{safe(case_name)} · Agent 执行过程</title><style>{_CSS}</style></head><body><main class="wrap">'
            f'<nav><a href="{safe(back)}">← 返回用例详情</a> · <a href="agent-output.log">原始日志</a> · '
            f'<a href="all-messages.json">原始消息</a></nav><h1>{safe(case_name)} · Agent 执行过程</h1>'
            f'<p class="sub">{safe(model or "模型未知")} · {safe(started_at or "开始时间未知")}'
            f'{" → " + safe(finished_at) if finished_at else ""}</p><div class="stats">{cards}</div>'
            '<div class="toolbar"><input id="search" type="search" placeholder="搜索回复、工具名、输入或输出" '
            'aria-label="搜索日志"><select id="filter" aria-label="筛选类型"><option value="all">全部类型</option>'
            '<option value="text">消息</option><option value="tool">工具</option><option value="reasoning">推理</option>'
            '<option value="error">错误</option><option value="other">其他</option></select>'
            '<button id="nextError" type="button">跳到下一个错误</button><span class="count" id="count"></span></div>'
            f'<div id="trace"></div><script type="application/json" id="traceData">{data}</script>'
            f'<script>{_SCRIPT}</script></main></body></html>')


def write_agent_trace(messages_path, **options):
    messages_path = Path(messages_path)
    sessions = json.loads(messages_path.read_text(encoding="utf-8"))
    target = messages_path.with_name("agent-output.html")
    target.write_text(render_agent_trace(sessions, **options), encoding="utf-8")
    return str(target)
