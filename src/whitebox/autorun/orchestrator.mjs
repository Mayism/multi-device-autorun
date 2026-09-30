import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { runPythonWorker, runPythonWorkerSync } from "../../runtime/python-worker.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function normalizeWhiteboxConfig(raw, outputRoot) {
  return JSON.parse(runPythonWorkerSync("whitebox-config", { raw, outputRoot }).toString("utf8"));
}

export function bindHarmonyBotWhiteboxRuntime(config, targets, baseDir = process.cwd()) {
  return JSON.parse(runPythonWorkerSync("whitebox-bind-runtime", { config, targets, baseDir }).toString("utf8"));
}

function providerList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.providers)) return value.providers;
  if (Array.isArray(value?.data?.providers)) return value.data.providers;
  return [];
}

// 白盒固定从自己的 HarmonyBot Server 解析 Provider。/config 提供连接配置，
// /config/providers 提供插件动态注册后的真实模型目录和已解析凭据。
export async function resolveWhiteboxJudgeRuntime({
  client,
  serverConfig,
  judge,
  generationModel,
  directory,
  signal,
}) {
  let runtimeProviders = [];
  try {
    runtimeProviders = providerList(await client.getProviders(directory, 30, signal));
  } catch (error) {
    if (signal?.aborted) throw error;
    // 兼容尚未提供 /config/providers 的旧版 OpenCode。
  }
  return JSON.parse((await runPythonWorker("whitebox-resolve-judge", {
    serverConfig,
    runtimeProviders,
    judge,
    generationModel,
  })).toString("utf8"));
}

function buildJudgeEnvironment({ config, judgeRuntime, opencodeBinPath }) {
  const { providerId, modelId, providerConfig } = judgeRuntime;
  const executableDir = path.dirname(opencodeBinPath);
  return {
    ...process.env,
    PATH: `${executableDir}${path.delimiter}${process.env.PATH || ""}`,
    HMOS_OPENCODE_HOST: "127.0.0.1",
    HMOS_OPENCODE_PORT: String(config.judge.basePort),
    HMOS_OPENCODE_PROVIDER_ID: providerId,
    HMOS_OPENCODE_MODEL_ID: modelId,
    HMOS_OPENCODE_PROVIDER_CONFIG: JSON.stringify(providerConfig),
    HMOS_OPENCODE_TIMEOUT_MS: String(config.timeoutSec * 1000),
    HMOS_OPENCODE_MAX_OUTPUT_BYTES: "1048576",
    HMOS_OPENCODE_RUNTIME_ROOT: config.runtimeRoot,
    HMOS_CODE_LINTER_ENABLED: String(config.officialLinter.enabled),
    HMOS_HVIGOR_BUILD_CHECK_ENABLED: String(config.hvigorBuildCheck.enabled),
  };
}

export async function prepareWhiteboxInput({
  batchId,
  caseInfo,
  agentResult,
  execution,
  config,
}) {
  const caseDir = path.dirname(agentResult.resultPath);
  const outputDir = path.join(caseDir, "whitebox");
  const inputsDir = path.join(outputDir, "inputs");
  const originalProjectPath = path.join(caseDir, "original");
  if (!await exists(originalProjectPath)) throw new Error(`白盒原始工程不存在: ${originalProjectPath}`);
  if (!await exists(agentResult.projectDir)) throw new Error(`白盒生成工程不存在: ${agentResult.projectDir}`);
  const patchPath = agentResult.patchPath && await exists(agentResult.patchPath)
    ? agentResult.patchPath
    : undefined;
  const originalPrompt = await fs.readFile(caseInfo.promptPath, "utf8");
  const additionalPrompt = config.prompt.includeAdditionalPrompt
    ? String(execution.additionalPrompt || "").trim()
    : "";
  const effectivePrompt = `${[originalPrompt.trim(), additionalPrompt].filter(Boolean).join("\n\n")}\n`;
  await fs.mkdir(inputsDir, { recursive: true });
  const originalPromptPath = path.join(inputsDir, "original-prompt.md");
  const effectivePromptPath = path.join(inputsDir, "effective-prompt.md");
  await fs.writeFile(originalPromptPath, originalPrompt, "utf8");
  await fs.writeFile(effectivePromptPath, effectivePrompt, "utf8");
  const patchBytes = patchPath ? await fs.readFile(patchPath) : undefined;
  const compile = agentResult.agentCompile || {};
  const persistedCompile = await readJson(agentResult.logs?.compileAttemptsPath);
  const rawAttempts = Array.isArray(agentResult.agentCompileAttempts)
    ? agentResult.agentCompileAttempts
    : Array.isArray(persistedCompile?.items) ? persistedCompile.items : [];
  const attempts = rawAttempts.map((item) => ({
    callId: String(item?.callId || ""),
    command: String(item?.command || ""),
    tasks: Array.isArray(item?.tasks) ? item.tasks.map((task) => String(task)) : [],
    outcome: String(item?.outcome || "unknown"),
    exitCode: Number.isFinite(Number(item?.exitCode)) ? Number(item.exitCode) : null,
    startedAt: String(item?.startedAt || ""),
    finishedAt: String(item?.finishedAt || ""),
    durationMs: Number.isFinite(Number(item?.durationMs)) ? Number(item.durationMs) : 0,
    description: String(item?.description || ""),
  }));
  const finalAttempt = [...attempts].reverse().find((item) =>
    ["succeeded", "failed", "interrupted", "running"].includes(item.outcome));
  const finalAttemptStatus = finalAttempt?.outcome || "not_run";
  const agentBuildStatus = finalAttemptStatus === "succeeded"
    ? "success"
    : finalAttemptStatus === "failed" ? "failed"
      : finalAttemptStatus === "interrupted" ? "interrupted"
        : finalAttemptStatus === "running" ? "unknown" : "not_run";
  const agentBuild = {
    source: "agent",
    status: agentBuildStatus,
    finalAttemptStatus,
    attempts,
    summary: {
      attempts: Number(compile.attempts || attempts.length || 0),
      succeeded: Number(compile.succeeded || 0),
      failed: Number(compile.failed || 0),
      interrupted: Number(compile.interrupted || 0),
      running: Number(compile.running || 0),
    },
  };
  const manifest = {
    schemaVersion: "whitebox-input-v1",
    caseId: caseInfo.name,
    taskType: "continuation",
    promptPath: effectivePromptPath,
    originalProjectPath,
    generatedProjectPath: agentResult.projectDir,
    ...(patchPath ? { patchPath } : {}),
    outputDir,
    agentBuild,
    metadata: {
      batchId,
      providerId: agentResult.providerId || "",
      modelId: agentResult.modelId || "",
      promptSha256: sha256(effectivePrompt),
      ...(patchBytes ? { patchSha256: sha256(patchBytes) } : {}),
      originalPromptPath,
      includesAdditionalPrompt: Boolean(additionalPrompt),
    },
  };
  const inputPath = path.join(inputsDir, "input.json");
  await writeJson(inputPath, manifest);
  return { inputPath, outputDir };
}

function runEvaluator({ cliPath, cwd, inputPath, port, env, timeoutSec, signal, logPath }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "--input", inputPath, "--port", String(port)], {
      cwd,
      env: { ...env, HMOS_OPENCODE_PORT: String(port) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let aborted = false;
    let terminating = false;
    let forceKillTimer;
    const terminateProcessTree = () => {
      if (!child.pid || terminating) return;
      terminating = true;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => child.kill());
        return;
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      forceKillTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree();
    }, timeoutSec * 1000);
    const onAbort = () => {
      aborted = true;
      terminateProcessTree();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", async (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      await fs.mkdir(path.dirname(logPath), { recursive: true }).catch(() => {});
      await fs.writeFile(logPath, `${Buffer.concat(stdout)}\n${Buffer.concat(stderr)}\n${error.stack || error.message}`, "utf8").catch(() => {});
      resolve({ status: "failed", error: error.message });
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, `${out}${err ? `\n[stderr]\n${err}` : ""}`, "utf8");
      const lastJsonLine = out.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith("{"));
      let parsed;
      try { parsed = lastJsonLine ? JSON.parse(lastJsonLine) : undefined; } catch { parsed = undefined; }
      if (code === 0 && parsed?.status === "completed") resolve(parsed);
      else resolve({
        status: timedOut ? "timed_out" : aborted ? "interrupted" : "failed",
        error: parsed?.error || err.trim() || `白盒评价进程退出码 ${code}`,
        ...(parsed || {}),
      });
    });
  });
}

export async function createWhiteboxOrchestrator({
  config,
  judgeRuntime,
  opencodeBinPath,
  repoRoot,
  signal,
}) {
  const whiteboxRoot = path.join(repoRoot, "src", "whitebox");
  const cliPath = path.join(whiteboxRoot, "dist", "localCli.js");
  if (!await exists(cliPath)) {
    throw new Error(`白盒评价尚未构建: ${cliPath}；请在工程根目录执行 npm install（会自动构建），或执行 npm run build:whitebox`);
  }
  const env = buildJudgeEnvironment({ config, judgeRuntime, opencodeBinPath });
  const pending = [];
  const allJobs = [];
  const freeSlots = Array.from({ length: config.concurrency }, (_, index) => index);

  function pump() {
    while (freeSlots.length > 0 && pending.length > 0) {
      const item = pending.shift();
      const slot = freeSlots.shift();
      runEvaluator({
        cliPath,
        cwd: whiteboxRoot,
        inputPath: item.inputPath,
        port: config.judge.basePort + slot,
        env,
        timeoutSec: config.timeoutSec,
        signal,
        logPath: path.join(item.outputDir, "logs", "evaluator-process.log"),
      }).then(item.resolve).finally(() => {
        freeSlots.push(slot);
        freeSlots.sort((left, right) => left - right);
        pump();
      });
    }
  }

  return {
    schedule(task) {
      const promise = new Promise((resolve) => pending.push({ ...task, resolve }));
      allJobs.push(promise);
      pump();
      return promise;
    },
    async waitAll() {
      return Promise.all(allJobs);
    },
    judge: {
      providerId: env.HMOS_OPENCODE_PROVIDER_ID,
      modelId: env.HMOS_OPENCODE_MODEL_ID,
    },
  };
}
