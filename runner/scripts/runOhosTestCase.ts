import path from "node:path";
import { parseOhosTestCaseArgs, runOhosTestCase } from "../src/index.js";

async function main(): Promise<void> {
  const input = parseOhosTestCaseArgs(process.argv.slice(2));
  const result = await runOhosTestCase(input);

  if (result.status !== "completed") {
    const resultPath = path.resolve(result.caseDir, result.artifacts.result);
    console.error(
      [
        `Runner failed: ${result.diagnostics[0] ?? "case_failed"}`,
        `Log: ${path.resolve(path.dirname(resultPath), result.artifacts.commandLog)}`,
        `Result: ${resultPath}`,
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        status: result.status,
        out: pathFromCaseDir(result.caseDir, result.artifacts.result),
        summary: pathFromCaseDir(result.caseDir, result.artifacts.summary),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function pathFromCaseDir(caseDir: string, value: string): string {
  return new URL(value, `file://${caseDir.replace(/\/?$/, "/")}`).pathname;
}
