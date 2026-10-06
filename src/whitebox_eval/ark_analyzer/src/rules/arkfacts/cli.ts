#!/usr/bin/env node
// ArkAnalyzer is the only Node runtime component retained by the Python evaluator.
import fs from "node:fs/promises";
import path from "node:path";
import { runArkAnalyzerFacts } from "./runner.js";

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) throw new Error("Usage: arkfacts/cli.js <input.json> <output.json>");
  const options = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const facts = await runArkAnalyzerFacts({ ...options, skipExternalExecution: false });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(facts), "utf8");
}

await main();
