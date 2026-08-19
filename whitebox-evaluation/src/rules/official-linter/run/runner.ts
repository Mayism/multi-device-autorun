import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OfficialLinterRunStatus } from "../../../types.js";

export interface OfficialCodeLinterRunResult {
  status: Exclude<OfficialLinterRunStatus, "not_installed" | "invalid_output">;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
}

export function runOfficialCodeLinter(input: {
  runDir: string;
  workspaceDir: string;
  timeoutMs: number;
}): Promise<OfficialCodeLinterRunResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const cliPath = path.join(input.runDir, "bin", "codelinter");
    const hasCliWrapper = fs.existsSync(cliPath);
    const child = hasCliWrapper
      ? spawn(cliPath, ["-c", "code-linter.json5", "-f", "json", "."], {
          cwd: input.workspaceDir,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn("node", ["./index.js", input.workspaceDir], {
          cwd: input.runDir,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        status: "failed",
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: `${Buffer.concat(stderrChunks).toString("utf-8")}\n${error.message}`.trim(),
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? "timeout" : code === 0 ? "success" : "failed",
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? undefined,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
