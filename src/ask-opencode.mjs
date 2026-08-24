#!/usr/bin/env node
// ask-opencode.mjs
// 向已启动的 opencode serve 发送消息，把 assistant 回复正文打到 stdout。
// 用法（与 plugin-cli/ask-opencode.{bat,ps1,sh} 功能、参数一致）：
//   node ask-opencode.mjs "你好"                          # 发送一条消息
//   echo "你好" | node ask-opencode.mjs                   # 从 stdin 读取
//   node ask-opencode.mjs "你好" --think                  # 保留 think 推理块
//   node ask-opencode.mjs "你好" --raw                    # 打印原始 JSON 响应
//   node ask-opencode.mjs "你好" -a harmonyos-ascf -m MiniMax-M3
//   node ask-opencode.mjs "你好" --port 62000             # 自定义端口
//   node ask-opencode.mjs "你好" --port 62000 --timeout 60
//   node ask-opencode.mjs "fix login" --cwd D:\workspace\projA   # 工作目录
//
// 终端（TTY）运行时默认进入「对话模式」：发完首问后，每轮回复结束会在 stderr
// 打出 `> ` 提示符，继续输入即可多轮对话；输入 :q 或 EOF/Ctrl+C 退出。
// 管道（非 TTY）运行时为单发：收完一个回复即退出（兼容老用法）。
//
// 前置：需先启动 ./run-opencode-serve.sh（或 .bat）。
// 一个 opencode 实例可同时服务多个项目：用 --cwd 切换每个请求的工作目录。
// CLI 参数优先于环境变量。可调：
//   --port, -p N        端口 (env: PORT, 默认 61417)
//   --host, -H H        主机 (env: HOST, 默认 127.0.0.1)
//   --timeout, -t S     单轮空闲超时秒 (env: TIMEOUT, 默认 120)
//   --cwd, -C PATH      工作目录 (env: CWD, 走 x-opencode-directory header)
//   --agent, -a NAME    agent 名 (env: AGENT)
//   --model, -m MODEL   model 名 (env: MODEL)
//   --think             保留 think 块
//   --raw               打印原始 JSON
//   --stream            非交互下强制流式单发（交互下恒为流式对话）
//   -h, --help          帮助
//
// 选 Node.js 而不是 PowerShell 5.1 的原因：后者在中文 Windows 上解码 UTF-8
// 响应时常走系统码页，导致中文乱码；Node.js 内部字符串一致为 UTF-16，对
// UTF-8 响应不会受系统码页影响。

import process from 'node:process';
import { Buffer } from 'node:buffer';
import readline from 'node:readline';

const DEFAULTS = Object.freeze({ HOST: '127.0.0.1', PORT: 61417, TIMEOUT: 120 });

const HELP = [
  '用法: node ask-opencode.mjs "question" [--think] [--raw] [--stream]',
  '                            [--agent NAME] [--model NAME]',
  '                            [--port N] [--host H] [--timeout S] [--cwd PATH]',
  '',
  '终端运行默认进入对话模式（多轮）；管道运行为单发。',
  'assistant 回复正文打到 stdout；model/agent 等元信息打到 stderr。',
  '',
  '选项:',
  '  --think               保留 think 推理块',
  '  --raw                 打印原始 JSON 响应',
  '  --stream              非交互下强制流式单发（交互下恒为流式对话）',
  '  --agent,  -a   NAME   agent 名 (如 harmonyos-ascf)',
  '  --model,  -m   MODEL  model/名，支持 provider/model (如 deepseek-v4-flash, deepseek/deepseek-v4-flash)',
  '  --port,   -p   N      端口 (默认 61417, env: PORT)',
  '  --host,   -H   HOST   主机 (默认 127.0.0.1, env: HOST)',
  '  --timeout, -t   S     单轮空闲超时秒数 (默认 120, env: TIMEOUT)',
  '  --cwd,    -C   PATH   工作目录 (env: CWD, 通过 x-opencode-directory 头)',
  '  -h, --help            显示此帮助',
  '',
  '对话模式（终端）:',
  '  回复结束后 stderr 出现 `> `，输入下一轮即可；:q / EOF / Ctrl+C 退出。',
  '',
  '示例:',
  '  node ask-opencode.mjs "hello" --port 62000',
  '  node ask-opencode.mjs "hello" -m MiniMax-M3 -p 62000',
  '  node ask-opencode.mjs "hello" --agent harmonyos-multi-device --model deepseek-chat',
  '  node ask-opencode.mjs "fix login" --cwd D:\\workspace\\projA --port 62000',
].join('\n');

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s + '\n');

function showHelp() {
  out(HELP + '\n');
  process.exit(0);
}

// ─── 参数解析（CLI 优先，env 作为兜底；与 .bat/.ps1/.sh 行为一致）───
function parseArgs(argv) {
  const opts = {
    think: false,
    raw: false,
    stream: false,
    agent: process.env.AGENT || '',
    model: process.env.MODEL || '',
    port: process.env.PORT || '',
    host: process.env.HOST || '',
    timeout: process.env.TIMEOUT || '',
    cwd: process.env.CWD || '',
    question: process.env.QUESTION || '',
  };

  const needValue = (flag) => {
    err(`[error] ${flag} 需要一个值`);
    process.exit(2);
  };

  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    switch (v) {
      case '-h':
      case '--help':
        showHelp();
        break;
      case '--think':
        opts.think = true;
        break;
      case '--raw':
        opts.raw = true;
        break;
      case '--stream':
        opts.stream = true;
        break;
      case '--agent':
      case '-a':
        if (a[i + 1] === undefined) needValue(v);
        opts.agent = a[++i];
        break;
      case '--model':
      case '-m':
        if (a[i + 1] === undefined) needValue(v);
        opts.model = a[++i];
        break;
      case '--port':
      case '-p':
        if (a[i + 1] === undefined) needValue(v);
        opts.port = a[++i];
        break;
      case '--host':
      case '-H':
        if (a[i + 1] === undefined) needValue(v);
        opts.host = a[++i];
        break;
      case '--timeout':
      case '-t':
        if (a[i + 1] === undefined) needValue(v);
        opts.timeout = a[++i];
        break;
      case '--cwd':
      case '-C':
        if (a[i + 1] === undefined) needValue(v);
        opts.cwd = a[++i];
        break;
      default:
        if (v.startsWith('-')) {
          err(`[error] 未知选项: ${v}`);
          process.exit(2);
        }
        if (opts.question) {
          err(`[error] 多余的位置参数: ${v}`);
          process.exit(2);
        }
        opts.question = v;
        break;
    }
  }
  return opts;
}

// ─── stdin fallback：非 TTY 且未传位置参数时，从 stdin 读问题 ──────
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function parsePositiveInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ─── HTTP 封装：永远返回 { ok, status, text, error? }，由调用者判断  ──
async function http(method, url, { body, headers: extraHeaders, timeout = 10 } = {}) {
  try {
    const init = {
      method,
      signal: AbortSignal.timeout(timeout * 1000),
    };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (extraHeaders && Object.keys(extraHeaders).length > 0) {
      init.headers = extraHeaders;
    }
    const res = await fetch(url, init);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e };
  }
}

function writeLine(rawText) {
  out(rawText);
  if (!rawText.endsWith('\n')) out('\n');
}

// ─── 对话式 SSE：一条 /event 长连接 + 每轮 prompt_async ─────────────
// opencode 的 /session/{id}/message 是「攒齐再发」-- 等到模型跑完才回一个
// 大 JSON，看不到首字节就会触发超时。真正增量的事件在 GET /event（SSE，全局
// 事件流），模型每生成一个 token 就通过 message.part.delta 推送；prompt_async
// 是「投递完立即返回」的版本，配合 SSE 实现真正的边收边打，且支持多轮对话。
//
// 返回 { sendTurn(text), abortSession() }。sendTurn 投递一轮并等
// session.status:idle，期间把 delta 实时打到 stdout；单轮超时则 POST /abort。
async function startConversation({ baseUrl, headers, sid, timeoutSec, opts, baseBody }) {
  const controller = new AbortController();
  let sseRes;
  try {
    sseRes = await fetch(`${baseUrl}/event`, {
      headers: { ...headers, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
  } catch (e) {
    err(`[error] SSE 订阅失败: ${e.message || e}`);
    process.exit(1);
  }
  if (!sseRes.ok || !sseRes.body) {
    err(`[error] SSE 订阅失败: HTTP ${sseRes.status}`);
    process.exit(1);
  }
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let connected = false;
  const info = {};
  let headerPrinted = false;

  // 每轮状态
  let turnTimer = null;
  let turnResolve = null;
  let turnHadText = false;

  const parseSseEvent = (chunk) => {
    let dataStr = null;
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) {
        const v = line.replace(/^data:\s*/, '');
        if (v) dataStr = (dataStr ? dataStr + '\n' : '') + v;
      }
    }
    if (!dataStr) return null;
    try { return JSON.parse(dataStr); } catch { return null; }
  };

  const maybePrintHeader = () => {
    if (!headerPrinted && (info.modelID || info.agent)) {
      headerPrinted = true;
      err(`[model=${info.modelID || '?'} agent=${info.agent || '?'}]`);
    }
  };

  const finishTurn = (result) => {
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    const r = turnResolve;
    turnResolve = null;
    if (r) r(result);
  };

  const onTimeout = async () => {
    turnTimer = null;
    try {
      await fetch(`${baseUrl}/session/${sid}/abort`, {
        method: 'POST',
        headers: { ...headers },
      });
    } catch { /* noop */ }
    finishTurn({ ok: false, error: new Error(`本轮超时（${timeoutSec}s 无新内容）`) });
  };

  // 后台读循环：跨多轮常驻，不随单轮结束而停
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // 收到字节即重置本轮 idle 计时（仅在轮次进行中）
        if (turnTimer) {
          clearTimeout(turnTimer);
          turnTimer = setTimeout(() => onTimeout(), timeoutSec * 1000);
        }
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const ev = parseSseEvent(chunk);
          if (!ev || typeof ev !== 'object') continue;
          if (!connected) {
            if (ev.type === 'server.connected') connected = true;
            continue;
          }
          const props = ev.properties || {};
          if (props.sessionID && props.sessionID !== sid) continue;

          if (ev.type === 'message.part.delta'
            && props.field === 'text'
            && typeof props.delta === 'string') {
            turnHadText = true;
            if (!opts.raw) {
              let delta = props.delta;
              if (!opts.think) {
                delta = delta.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
              }
              if (delta) process.stdout.write(delta);
            }
            maybePrintHeader();
            if (!opts.raw) continue;
          }

          if (ev.type === 'session.next.agent.switched' && props.agent) info.agent = props.agent;
          if (ev.type === 'session.next.model.switched' && props.model && props.model.id) {
            info.modelID = props.model.id;
          }
          if (ev.type === 'message.updated' && props.info) {
            if (props.info.modelID) info.modelID = props.info.modelID;
            if (props.info.agent) info.agent = props.info.agent;
          }
          if (ev.type === 'session.updated' && props.info) {
            if (props.info.model && props.info.model.id) info.modelID = props.info.model.id;
            if (props.info.agent) info.agent = props.info.agent;
          }

          if (ev.type === 'session.status' && props.status && props.status.type === 'idle') {
            finishTurn({ ok: true, hadText: turnHadText });
            continue;
          }
          if (ev.type === 'session.error') {
            finishTurn({ ok: false, error: props });
            continue;
          }
          // agent 用 question 工具向用户提问：会话保持 busy，不会 idle。
          // 把问题抛给主循环展示并收集答案，回答后继续等下一轮。
          if (ev.type === 'question.asked') {
            finishTurn({ ok: true, question: props });
            continue;
          }

          if (opts.raw) process.stdout.write(JSON.stringify(ev) + '\n');
        }
      }
    } catch (e) {
      finishTurn({ ok: false, error: e });
    }
  })();

  // 等到 server.connected 再允许投递
  while (!connected) {
    await new Promise((r) => setTimeout(r, 20));
  }

  async function sendTurn(text) {
    const body = { ...baseBody, parts: [{ type: 'text', text }] };
    turnHadText = false;
    // 先挂上 resolver 与计时，再投递，避免服务端极快回包时丢事件
    turnTimer = setTimeout(() => onTimeout(), timeoutSec * 1000);
    const resultPromise = new Promise((resolve) => { turnResolve = resolve; });
    const res = await fetch(`${baseUrl}/session/${sid}/prompt_async`, {
      method: 'POST',
      headers: { ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
      turnResolve = null;
      const t = await res.text().catch(() => '');
      err(`[error] prompt_async 失败: HTTP ${res.status}`);
      if (t) process.stderr.write(t + '\n');
      return { ok: false, error: new Error('prompt_async failed') };
    }
    const result = await resultPromise;
    if (result.ok && !result.question && !opts.raw) process.stdout.write('\n');
    return result;
  }

  // 回答完 question 后继续等下一轮（agent 会自行恢复并产出更多内容）
  function waitAfterReply() {
    turnHadText = false;
    turnTimer = setTimeout(() => onTimeout(), timeoutSec * 1000);
    return new Promise((resolve) => { turnResolve = resolve; });
  }

  async function replyQuestion(requestID, answers) {
    const url = new URL(`${baseUrl}/question/${requestID}/reply`);
    if (opts.cwd) url.searchParams.set('directory', opts.cwd);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers },
      body: JSON.stringify({ answers }),
    });
    return res.ok;
  }

  async function rejectQuestion(requestID) {
    const url = new URL(`${baseUrl}/question/${requestID}/reject`);
    if (opts.cwd) url.searchParams.set('directory', opts.cwd);
    try {
      await fetch(url, { method: 'POST', headers: { ...headers } });
    } catch { /* noop */ }
  }

  async function abortSession() {
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    try {
      await fetch(`${baseUrl}/session/${sid}/abort`, {
        method: 'POST',
        headers: { ...headers },
      });
    } catch { /* noop */ }
    controller.abort();
    try { reader.cancel(); } catch { /* noop */ }
  }

  return {
    sendTurn, waitAfterReply, replyQuestion, rejectQuestion, abortSession,
    getInfo: () => info,
  };
}

// ─── 终端交互：读一行 stdin；EOF/Ctrl+C 返回 null ──────────────────
function promptLine(promptStr = '\n> ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    rl.question(promptStr, (answer) => finish(answer));
    rl.on('close', () => finish(null));
    rl.on('SIGINT', () => finish(null));
  });
}

// ─── 展示 question.asked 的结构化问题并收集用户选择 ───────────────
// 返回 answers: string[][]（每问一组已选 label）；用户放弃（:q/EOF）返回 null。
async function handleQuestion(qProps) {
  const questions = qProps.questions || [];
  const answers = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] || {};
    err(`\n[Q${i + 1}] ${q.header || ''}`);
    err(q.question || '');
    const opts2 = Array.isArray(q.options) ? q.options : [];
    opts2.forEach((o, j) => {
      err(`  ${j + 1}. ${o.label}${o.description ? '  —  ' + o.description : ''}`);
    });
    const line = await promptLine(opts2.length ? '选择 (默认 1，多选用逗号): ' : '回答: ');
    if (line === null) return null;
    const t = line.trim();
    if (t === ':q' || t === ':exit' || t === ':quit') return null;
    if (!opts2.length) {
      // 自由文本回答
      answers.push([t || '']);
      continue;
    }
    const picks = t
      ? [...new Set(t.split(/[,\s]+/).map((s) => parseInt(s, 10)))]
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= opts2.length)
      : [1];
    const sel = (picks.length ? picks : [1]).map((n) => opts2[n - 1].label);
    answers.push(sel);
  }
  return answers;
}

// ─── 真正开始 ──────────────────────────────────────────────────
const opts = parseArgs(process.argv);

// 非 TTY 时，未传位置参数则从 stdin 读问题；TTY 时空问题留待对话模式处理
if (!opts.question && !process.stdin.isTTY) {
  const fromStdin = await readStdin();
  if (fromStdin) opts.question = fromStdin;
}

const host = opts.host || DEFAULTS.HOST;
const port = parsePositiveInt(opts.port, DEFAULTS.PORT);
const timeoutSec = parsePositiveInt(opts.timeout, DEFAULTS.TIMEOUT);
const baseUrl = `http://${host}:${port}`;

const headers = { 'Content-Type': 'application/json' };
if (opts.cwd) headers['x-opencode-directory'] = opts.cwd;

const req = (method, url, opts2 = {}) =>
  http(method, url, { ...opts2, headers: Object.assign(headers, opts2.headers || {}) });

// ─── 健康检查 ────────────────────────────────────────────────
{
  const h = await req('GET', `${baseUrl}/global/health`, { timeout: 3 });
  if (!h.ok) {
    err(`[error] opencode serve 未运行于 ${baseUrl}`);
    err('        请先启动 run-opencode-serve(.bat/.sh)，或用 PORT= 覆盖端口');
    process.exit(1);
  }
}

// ─── 把 --model 解析成 { providerID, modelID } ─────────────────
// 接受两种写法：
//   --model MODEL                    裸 model id：先在 /config provider.models
//                                    里查；查不到则当 server 只有一个 provider 时
//                                    假定属于它（provider 未静态声明 models 也能
//                                    透传，与扩展行为一致）
//   --model PROVIDER/MODEL           provider/model：只校验 provider 存在，不要求
//                                    model 在 provider.models 中被声明
// 环境变量 MODEL 同义，只是无法通过 CLI 插入 /。
let providerId = '';
let modelId = '';
if (opts.model) {
  const cfgRes = await req('GET', `${baseUrl}/config`, { timeout: 10 });
  if (!cfgRes.ok) {
    err(`[error] 读 /config 失败: HTTP ${cfgRes.status}`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(cfgRes.text);
  } catch (e) {
    err(`[error] /config 不是合法 JSON: ${e?.message || e}`);
    process.exit(1);
  }
  const providers = cfg.provider || {};
  const providerIds = Object.keys(providers);

  const slashIdx = opts.model.indexOf('/');
  if (slashIdx > 0) {
    // provider/model 形式：只校验 provider 存在
    providerId = opts.model.slice(0, slashIdx).trim();
    modelId = opts.model.slice(slashIdx + 1).trim();
    if (!providers[providerId]) {
      err(`[error] provider '${providerId}' 未在 server 找到。可用 provider:`);
      for (const pid of providerIds) {
        err(`  ${pid}`);
      }
      process.exit(1);
    }
  } else {
    // 裸 model id：在 provider.models 里查；单 provider 兜底
    modelId = opts.model;
    for (const [pid, p] of Object.entries(providers)) {
      const models = p && p.models;
      if (models && Object.prototype.hasOwnProperty.call(models, opts.model)) {
        providerId = pid;
        break;
      }
    }
    if (!providerId && providerIds.length === 1) {
      providerId = providerIds[0];
      err(`[info] model '${opts.model}' 未在 provider.models 声明，假定属于唯一 provider '${providerId}'`);
    }
    if (!providerId) {
      err(`[error] model '${opts.model}' 未在 server 找到。可用 provider:`);
      for (const pid of providerIds) {
        const declared = Object.keys((providers[pid] && providers[pid].models) || {});
        if (declared.length) {
          err(`  ${pid}  (已声明 model: ${declared.join(', ')})`);
        } else {
          err(`  ${pid}  (未声明 model，可用 --model <provider>/<model> 指定)`);
        }
      }
      process.exit(1);
    }
  }
}

// ─── 建会话 ──────────────────────────────────────────────────
{
  const r = await req('POST', `${baseUrl}/session`, { body: '{}', timeout: 10 });
  if (!r.ok) {
    err(`[error] 创建会话失败: HTTP ${r.status}`);
    if (r.text) process.stderr.write(r.text + '\n');
    process.exit(1);
  }
  let sid;
  try {
    sid = JSON.parse(r.text).id;
  } catch (e) {
    err(`[error] /session 响应不是合法 JSON: ${e?.message || e}`);
    process.exit(1);
  }
  if (!sid) {
    err('[error] 空 session id');
    process.exit(1);
  }

  // agent/model 在整个会话固定；每轮只换 parts
  const baseBody = {};
  if (opts.agent) baseBody.agent = opts.agent;
  if (opts.model && providerId) {
    baseBody.model = { providerID: providerId, modelID: modelId };
  }

  const interactive = process.stdin.isTTY;

  // ─── 流式：对话模式（TTY）或非交互 --stream 单发 ───────────
  if (interactive || opts.stream) {
    const convo = await startConversation({
      baseUrl, headers, sid, timeoutSec, opts, baseBody,
    });

    // Ctrl+C：中止服务端任务后退出
    let interrupted = false;
    const onSigInt = async () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      try { await convo.abortSession(); } catch { /* noop */ }
      process.exit(130);
    };
    process.on('SIGINT', onSigInt);

    const reportErr = (r) => {
      if (r && !r.ok) {
        const e = r.error;
        let str;
        if (e instanceof Error) str = e.message;
        else { try { str = JSON.stringify(e); } catch { str = String(e); } }
        err('[error] ' + str);
      }
    };

    if (interactive) {
      // ── 对话模式：先发首问（若有），再循环等输入 ──
      let result;
      if (opts.question) {
        result = await convo.sendTurn(opts.question);
      } else {
        err('已进入对话模式，直接提问即可（:q 退出）。');
        result = { ok: true, idle: true };
      }
      while (true) {
        // 连续处理 question.asked（agent 可能连问多组）
        while (result && result.ok && result.question) {
          const answers = await handleQuestion(result.question);
          if (answers === null) {
            // 用户放弃：reject 当前问题后退出
            await convo.rejectQuestion(result.question.id);
            process.exit(0);
          }
          const ok = await convo.replyQuestion(result.question.id, answers);
          if (!ok) {
            err('[error] 回答提交失败');
            result = { ok: false, error: new Error('reply failed') };
            break;
          }
          result = await convo.waitAfterReply();
        }
        if (result && !result.ok) reportErr(result);
        // idle：提示下一轮自由输入
        const line = await promptLine();
        if (line === null) break; // EOF / Ctrl+C
        const t = line.trim();
        if (!t) continue;
        if (t === ':q' || t === ':exit' || t === ':quit') break;
        result = await convo.sendTurn(t);
      }
      process.removeListener('SIGINT', onSigInt);
      await convo.abortSession();
      process.exit(0);
    } else {
      // ── 非交互 --stream 单发 ──
      if (!opts.question) {
        err('[error] 未提供问题。用法: node ask-opencode.mjs "你的问题"');
        process.exit(1);
      }
      const r = await convo.sendTurn(opts.question);
      process.removeListener('SIGINT', onSigInt);
      await convo.abortSession();
      if (!r.ok) {
        reportErr(r);
        process.exit(1);
      }
      process.exit(0);
    }
  }

  // ─── 非流式缓冲路径（管道单发，原有逻辑） ─────────────────
  if (!opts.question) {
    err('[error] 未提供问题。用法: node ask-opencode.mjs "你的问题"');
    process.exit(1);
  }
  const body = { parts: [{ type: 'text', text: opts.question }] };
  if (opts.agent) body.agent = opts.agent;
  if (opts.model && providerId) {
    body.model = { providerID: providerId, modelID: modelId };
  }

  const m = await req('POST', `${baseUrl}/session/${sid}/message`, {
    body,
    timeout: timeoutSec,
  });
  if (!m.ok) {
    err(`[error] 请求失败: HTTP ${m.status}`);
    if (m.text) process.stderr.write(m.text + '\n');
    if (m.error) err(`        ${m.error.message || m.error}`);
    process.exit(1);
  }
  const raw = m.text;

  // --raw：原样输出（但确保末尾换行，便于管道后续处理）
  if (opts.raw) {
    writeLine(raw);
    process.exit(0);
  }

  // ─── 解析响应（单个 JSON 或 NDJSON） ─────────────────────
  const objs = [];
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      objs.push(JSON.parse(trimmed));
    } catch {
      for (const line of trimmed.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          objs.push(JSON.parse(t));
        } catch {
          /* 忽略无法解析的行，行为与 .ps1/.sh 保持一致 */
        }
      }
    }
  }

  if (objs.length === 0) {
    err('[error] 无法解析响应');
    writeLine(raw);
    process.exit(0);
  }

  let firstErr = null;
  let info = {};
  const texts = [];
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    if (!firstErr && o.error) firstErr = o.error;
    if (o.info && !info.modelID && !info.agent) info = o.info;
    if (Array.isArray(o.parts)) {
      for (const p of o.parts) {
        if (p && p.type === 'text' && typeof p.text === 'string') {
          texts.push(p.text);
        }
      }
    }
  }

  if (firstErr) {
    let str;
    if (typeof firstErr === 'string') str = firstErr;
    else {
      try {
        str = JSON.stringify(firstErr);
      } catch {
        str = String(firstErr);
      }
    }
    err('[error] ' + str);
    process.exit(1);
  }

  if (info.modelID || info.agent) {
    err(`[model=${info.modelID || '?'} agent=${info.agent || '?'}]`);
  }

  let reply = texts.join('\n');
  if (!opts.think) {
    // 去掉 think 推理块；行为与 .ps1/.sh 中的正则一致
    reply = reply.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  }
  writeLine(reply.replace(/\s+$/, '') + '\n');
}
