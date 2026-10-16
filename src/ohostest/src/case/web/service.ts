import fs from "node:fs/promises";
import path from "node:path";
import type { RunnerLogger } from "../../logging/logger.js";
import {
  resolveNpmCli,
  resolveNpmInstallCommand,
  validateWebProject,
  webEnvironment,
} from "./npm.js";
import {
  assertPortFree,
  waitForPortRelease,
  waitForWebReady,
} from "./readiness.js";
import { WEB_STARTUP_TIMEOUT_MS } from "./constants.js";
import {
  startProcess,
  stopProcess,
  waitForExit,
  assertRunning,
  type OwnedProcess,
} from "./process.js";

interface WebServiceInput {
  project: string;
  readyUrl: string;
  outDir: string;
  phase: "swe" | "answer";
  logger: RunnerLogger;
  signal?: AbortSignal;
}

interface WebSession {
  input: WebServiceInput;
  logDir: string;
  npm: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  processes: OwnedProcess[];
}

export async function withWebService<T>(
  input: WebServiceInput,
  run: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("web_run_interrupted"));
  const signal = input.signal
    ? AbortSignal.any([controller.signal, input.signal])
    : controller.signal;
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let session: WebSession | undefined;
  let failure: unknown;
  const stopOnAbort = () => {
    for (const owned of session?.processes ?? []) {
      void stopProcess(owned).catch((error: unknown) =>
        input.logger.recordError(error),
      );
    }
  };
  signal.addEventListener("abort", stopOnAbort, { once: true });
  try {
    session = await createSession(input, signal);
    await installDependencies(session);
    const server = await startServer(session);
    const result = await run();
    signal.throwIfAborted();
    assertRunning(server);
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (session) await cleanupSession(session);
    } catch (error) {
      if (failure)
        throw new AggregateError(
          [failure, error],
          `${String(failure)}; web_cleanup_failed: ${String(error)}`,
        );
      throw error;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      signal.removeEventListener("abort", stopOnAbort);
    }
  }
}

async function createSession(
  input: WebServiceInput,
  signal: AbortSignal,
): Promise<WebSession> {
  signal.throwIfAborted();
  await validateWebProject(input.project);
  await assertPortFree(input.readyUrl);
  const logDir = path.join(input.outDir, "web", input.phase);
  await fs.mkdir(logDir, { recursive: true });
  return {
    input,
    logDir,
    signal,
    npm: await resolveNpmCli(),
    env: await webEnvironment(input.outDir),
    processes: [],
  };
}

function launch(
  session: WebSession,
  args: string[],
  logName: string,
): OwnedProcess {
  session.signal.throwIfAborted();
  const owned = startProcess({
    file: process.execPath,
    args: [session.npm, ...args],
    cwd: session.input.project,
    env: session.env,
    log: path.join(session.logDir, logName),
  });
  session.processes.push(owned);
  return owned;
}

async function installDependencies(session: WebSession): Promise<void> {
  const command = await resolveNpmInstallCommand(session.input.project);
  const args = [command, "--no-audit", "--no-fund"];
  // A generated SWE lock must not change how an unlocked Answer is installed.
  if (command === "install") args.push("--package-lock=false");
  const started = Date.now();
  let exitCode = 1;
  try {
    const owned = launch(session, args, "install.log");
    const result = await waitForExit(owned, session.signal);
    exitCode = result.code ?? 1;
    if (exitCode !== 0)
      throw new Error(
        `web_install_failed: ${JSON.stringify(result)}; see ${session.logDir}/install.log`,
      );
  } finally {
    session.input.logger.recordCommand(`npm ${args.join(" ")}`, {
      exitCode,
      durationMs: Date.now() - started,
      stdout: `log: ${path.join(session.logDir, "install.log")}`,
      stderr: "",
    });
  }
}

async function startServer(session: WebSession): Promise<OwnedProcess> {
  await assertPortFree(session.input.readyUrl);
  const started = Date.now();
  let exitCode = 1;
  try {
    const owned = launch(session, ["run", "dev"], "dev.log");
    await waitForWebReady({
      process: owned,
      url: session.input.readyUrl,
      timeoutMs: WEB_STARTUP_TIMEOUT_MS,
      signal: session.signal,
    });
    exitCode = 0;
    return owned;
  } finally {
    session.input.logger.recordCommand("npm run dev", {
      exitCode,
      durationMs: Date.now() - started,
      stdout: `log: ${path.join(session.logDir, "dev.log")}`,
      stderr: "",
    });
  }
}

async function cleanupSession(session: WebSession): Promise<void> {
  const started = Date.now();
  const failures: unknown[] = [];
  for (const owned of [...session.processes].reverse()) {
    try {
      await stopProcess(owned);
    } catch (error) {
      failures.push(error);
    }
  }
  if (process.platform === "win32" && session.processes.length) {
    try {
      // Verify release after terminating owned Jobs; never kill a port's occupant.
      await waitForPortRelease(session.input.readyUrl);
    } catch (error) {
      failures.push(error);
    }
  }
  session.input.logger.recordCommand("stop owned web processes", {
    exitCode: failures.length ? 1 : 0,
    durationMs: Date.now() - started,
    stdout: "",
    stderr: failures.map(String).join("; "),
  });
  if (failures.length)
    throw new Error(`web_cleanup_failed: ${failures.map(String).join("; ")}`);
}
