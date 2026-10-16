import fs from "node:fs/promises";
import path from "node:path";

function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function escapeHtml(value) {
  return text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function embeddedJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => ({
    "<": "\\u003c", ">": "\\u003e", "&": "\\u0026",
    "\u2028": "\\u2028", "\u2029": "\\u2029",
  })[char]);
}

function content(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
}

function timestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatDuration(startedAt, finishedAt) {
  const milliseconds = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "--";
  const seconds = Math.round(milliseconds / 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function formatTokenCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return "0k";
  const thousands = count / 1000;
  const decimals = thousands < 1 ? 2 : thousands < 1000 ? 1 : 0;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals }).format(thousands)}k`;
}

export function normalizeAgentTrace(sessions) {
  return (Array.isArray(sessions) ? sessions : []).map((session, sessionIndex) => {
    const entries = [];
    if (session?.error) entries.push({ kind: "error", role: "system", title: "Session 读取失败", body: text(session.error) });
    for (const [messageIndex, message] of (Array.isArray(session?.messages) ? session.messages : []).entries()) {
      const info = message?.info || {};
      const role = text(info.role || message?.role || "unknown");
      const messageId = text(info.id || message?.id);
      const messageTime = timestamp(info.time?.created);
      for (const [partIndex, part] of (Array.isArray(message?.parts) ? message.parts : []).entries()) {
        const type = text(part?.type || "unknown").toLowerCase();
        if (type === "step-start" || type === "step-finish") continue;
        const base = { role, messageId, messageIndex, partIndex, time: messageTime };
        if (type === "text" || type === "reasoning") {
          entries.push({ ...base, kind: type, title: type === "reasoning" ? "推理" : role === "user" ? "用户消息" : "Agent 回复", body: text(part.text) });
        } else if (type === "tool") {
          const state = part.state || {};
          const output = state.output ?? state.metadata?.output;
          entries.push({ ...base, kind: "tool", title: text(part.tool || "未知工具"), status: text(state.status || "unknown"),
            callId: text(part.callID || part.callId), start: timestamp(state.time?.start), end: timestamp(state.time?.end),
            input: state.input === undefined ? "" : content(state.input), output: output === undefined ? "" : content(output),
            error: state.error === undefined ? "" : content(state.error) });
        } else if (type === "patch") {
          entries.push({ ...base, kind: "patch", title: "文件变更", body: content(part) });
        } else {
          entries.push({ ...base, kind: "other", title: type || "其他内容", body: content(part) });
        }
      }
    }
    return { id: text(session?.sessionId), label: `Session ${sessionIndex + 1}`, entries };
  });
}

export function renderAgentOutputHtml({ sessions, caseName = "", agentStatus = "", agentError = "", model = "", startedAt = "", finishedAt = "", tokenUsage = {} } = {}) {
  const trace = normalizeAgentTrace(sessions);
  if (agentError) {
    if (!trace.length) trace.push({ id: "", label: "Session 1", entries: [] });
    trace.at(-1).entries.push({ kind: "error", role: "system", title: "Agent 执行错误", body: text(agentError), time: Date.parse(finishedAt) || null });
  }
  const entries = trace.flatMap((session) => session.entries);
  const toolCount = entries.filter((entry) => entry.kind === "tool").length;
  const errorCount = entries.filter((entry) => entry.kind === "error" || entry.error || entry.status === "error").length;
  const backHref = `../../subpage/${encodeURIComponent(caseName)}.html`;
  const data = embeddedJson(trace);
  const statusLabels = { completed: "已完成", failed: "失败", timed_out: "超时", rate_limited: "限额", interrupted: "已中断", cancelled: "已取消" };
  const durationText = formatDuration(startedAt, finishedAt);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(caseName)} · Agent 执行过程</title>
<style>
  :root{color-scheme:light;--bg:#f5f7fa;--card:#fff;--ink:#1f2733;--muted:#6b7785;--line:#e4e8ee;--blue:#0a7cff;--red:#c73535}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1180px;margin:auto;padding:24px 20px 64px}a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
  h1{font-size:23px;margin:14px 0 4px}.sub{color:var(--muted);margin:0 0 20px;word-break:break-all}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-bottom:18px}
  .stat,.toolbar,.session,.entry{background:var(--card);border:1px solid var(--line);border-radius:9px}
  .stat{padding:11px 14px}.stat b{display:block;font-size:18px;overflow-wrap:anywhere}.stat span{font-size:12px;color:var(--muted)}
  .toolbar{position:sticky;top:0;z-index:2;padding:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;box-shadow:0 2px 8px #18273c0b}
  input,select,button{font:inherit;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);padding:7px 9px}
  input{flex:1;min-width:220px}button{cursor:pointer}button:hover{border-color:var(--blue)}.count{color:var(--muted);font-size:12px;margin-left:auto}
  .session{margin-top:16px;padding:14px}.session h2{font-size:16px;margin:0 0 8px}.session small{color:var(--muted);font-weight:400;margin-left:8px;word-break:break-all}
  .entry{margin:8px 0;padding:10px 12px;border-left:3px solid #9db8d8}.entry.tool{border-left-color:#9b75d9}.entry.error{border-left-color:var(--red)}.entry.reasoning{border-left-color:#a3abb5}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.title{font-weight:650}.tag{font-size:11px;border-radius:12px;background:#eef2f7;padding:2px 7px}.tag.error{background:#fdecec;color:var(--red)}
  .meta{color:var(--muted);font-size:12px;margin-left:auto}.preview{color:#405064;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:3.2em;overflow:hidden}
  details{margin-top:6px}summary{color:var(--blue);cursor:pointer;font-size:12px}pre{margin:8px 0 0;padding:12px;background:#f4f6f9;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;max-height:65vh;overflow:auto}
  .block-title{font-size:12px;color:var(--muted);margin-top:10px}.empty{padding:28px;text-align:center;color:var(--muted)}
  @media(max-width:620px){.wrap{padding:14px 10px 40px}.toolbar{position:static}.meta{margin-left:0;width:100%}}
</style></head><body><main class="wrap">
<nav><a href="${escapeHtml(backHref)}">← 返回用例详情</a> · <a href="agent-output.log">原始日志</a> · <a href="all-messages.json">原始消息</a></nav>
<h1>${escapeHtml(caseName)} · Agent 执行过程</h1><p class="sub">${escapeHtml(model || "模型未知")} · ${escapeHtml(startedAt || "开始时间未知")}${finishedAt ? ` → ${escapeHtml(finishedAt)}` : ""}</p>
<div class="stats"><div class="stat"><span>Agent 状态</span><b>${escapeHtml(statusLabels[agentStatus] || agentStatus || "未知")}</b></div><div class="stat"><span>Agent 耗时</span><b>${durationText}</b></div><div class="stat"><span>Session</span><b>${trace.length}</b></div><div class="stat"><span>工具调用</span><b>${toolCount}</b></div><div class="stat"><span>错误</span><b>${errorCount}</b></div><div class="stat"><span>总 Token</span><b>${formatTokenCount(tokenUsage?.total)}</b></div></div>
<div class="toolbar"><input id="search" type="search" placeholder="搜索回复、工具名、输入或输出" aria-label="搜索日志"><select id="filter" aria-label="筛选类型"><option value="all">全部类型</option><option value="text">消息</option><option value="tool">工具</option><option value="reasoning">推理</option><option value="error">错误</option><option value="other">其他</option></select><button id="nextError" type="button">跳到下一个错误</button><span class="count" id="count"></span></div>
<div id="trace"></div><script type="application/json" id="traceData">${data}</script>
<script>
(()=>{
  const sessions=JSON.parse(document.getElementById('traceData').textContent);
  const root=document.getElementById('trace'),search=document.getElementById('search'),filter=document.getElementById('filter'),count=document.getElementById('count');
  const isError=e=>e.kind==='error'||Boolean(e.error)||e.status==='error';
  const line=(tag,cls,value)=>{const el=document.createElement(tag);if(cls)el.className=cls;el.textContent=value;return el};
  const preview=e=>e.kind==='tool'?(e.error||e.output||e.input):e.body;
  const matchesKind=(entry,kind)=>kind==='all'||(kind==='error'?isError(entry):kind==='other'?['patch','other'].includes(entry.kind):entry.kind===kind);
  function addBlock(container,label,value){if(!value)return;container.append(line('div','block-title',label));container.append(line('pre','',value))}
  function draw(){const query=search.value.trim().toLocaleLowerCase(),kind=filter.value;root.replaceChildren();let shown=0,errors=[];
    for(const session of sessions){const section=line('section','session','');const heading=line('h2','',session.label);heading.append(line('small','',session.id));section.append(heading);let sessionShown=0;
      for(const entry of session.entries){const bad=isError(entry);if(!matchesKind(entry,kind))continue;
        const searchable=[entry.title,entry.body,entry.input,entry.output,entry.error,entry.messageId,entry.callId].join(' ').toLocaleLowerCase();if(query&&!searchable.includes(query))continue;
        const card=line('article','entry '+(bad?'error':entry.kind),'');const header=line('div','row','');header.append(line('span','title',entry.title));header.append(line('span','tag'+(bad?' error':''),entry.kind==='tool'?entry.status:entry.role));
        const when=entry.start||entry.time;const duration=entry.start&&entry.end?' · '+Math.max(0,entry.end-entry.start)+' ms':'';
        header.append(line('span','meta',(when?new Date(when).toLocaleString():'时间未知')+duration));card.append(header);
        const snippet=preview(entry)||'';if(snippet)card.append(line('div','preview',snippet.slice(0,240)));
        const details=document.createElement('details');details.append(line('summary','','查看完整内容'));
        details.addEventListener('toggle',()=>{if(!details.open||details.dataset.loaded)return;addBlock(details,'消息 '+(entry.messageId||''),entry.body);addBlock(details,'工具输入',entry.input);addBlock(details,'工具输出',entry.output);addBlock(details,'错误',entry.error);details.dataset.loaded='1'});
        if(entry.body||entry.input||entry.output||entry.error)card.append(details);section.append(card);shown++;sessionShown++;if(bad)errors.push(card);
      }if(sessionShown)root.append(section)
    }if(!shown)root.append(line('div','empty','没有匹配的记录'));count.textContent='显示 '+shown+' 条';window.__traceErrors=errors;
  }
  let timer;search.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(draw,150)});filter.addEventListener('change',draw);
  document.getElementById('nextError').addEventListener('click',()=>{if(!(window.__traceErrors||[]).length){search.value='';filter.value='error';draw()}const items=window.__traceErrors||[];if(!items.length)return;const next=items.find(item=>item.getBoundingClientRect().top>90)||items[0];next.scrollIntoView({behavior:'smooth',block:'center'})});draw();
})();
</script></main></body></html>`;
}

export async function writeAgentOutputHtml({ messagesPath, caseName, agentStatus, agentError, model, startedAt, finishedAt, tokenUsage }) {
  const sessions = JSON.parse(await fs.readFile(messagesPath, "utf8"));
  const outputPath = path.join(path.dirname(messagesPath), "agent-output.html");
  await fs.writeFile(outputPath, renderAgentOutputHtml({ sessions, caseName, agentStatus, agentError, model, startedAt, finishedAt, tokenUsage }), "utf8");
  return outputPath;
}
