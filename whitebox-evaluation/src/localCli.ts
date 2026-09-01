#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { LocalWhiteboxInput, LocalWhiteboxRunSummary } from "./localContracts.js";
import { runLocalWhiteboxEvaluation } from "./localEvaluation.js";

function parseArgs(argv: string[]): { inputPath: string; port?: number } {
  let inputPath = "";
  let port: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") inputPath = argv[++index] ?? "";
    else if (value === "--port") port = Number(argv[++index]);
    else if (value === "--help" || value === "-h") {
      console.log("用法: node dist/localCli.js --input <whitebox/input.json> [--port 62400]");
      process.exit(0);
    } else throw new Error(`未知参数: ${value}`);
  }
  if (!inputPath) throw new Error("缺少 --input");
  if (port !== undefined && (!Number.isInteger(port) || port <= 0)) throw new Error("--port 必须是正整数");
  return { inputPath: path.resolve(inputPath), port };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(await fs.readFile(args.inputPath, "utf-8")) as LocalWhiteboxInput;
  const repoRoot = path.dirname(fileURLToPath(import.meta.url)).endsWith(`${path.sep}dist`)
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let summary: LocalWhiteboxRunSummary;
  try {
    summary = await runLocalWhiteboxEvaluation(input, { repoRoot, port: args.port });
  } catch (error) {
    summary = {
      status: "failed",
      caseId: input.caseId,
      outputDir: input.outputDir,
      error: error instanceof Error ? error.message : String(error),
    };
    await fs.mkdir(input.outputDir, { recursive: true });
    await fs.writeFile(path.join(input.outputDir, "failure.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.status !== "completed") process.exitCode = 1;
}

await main();
