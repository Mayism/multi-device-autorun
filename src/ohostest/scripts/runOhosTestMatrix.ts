import path from "node:path";
import { parseOhosTestMatrixArgs, runOhosTestMatrix } from "../src/index.js";
import type { MatrixResult } from "../src/matrix/types/index.js";

async function main(): Promise<void> {
  const parsed = parseOhosTestMatrixArgs(process.argv.slice(2));
  const input = {
    ...parsed,
    out:
      parsed.out ??
      path.join(
        path.resolve(parsed.project),
        ".ohostest-runs",
        compactTimestamp(new Date()),
        "result.json",
      ),
  };
  const result = await runOhosTestMatrix(input);

  if (result.status === "completed") {
    console.log(
      JSON.stringify({ status: result.status, out: input.out }, null, 2),
    );
    return;
  }

  printFailureSummary(result, input.out);
  process.exitCode = 1;
}

function printFailureSummary(
  result: MatrixResult,
  out: string | undefined,
): void {
  const resultPath = path.resolve(
    out ?? path.join(result.project, "result.json"),
  );
  const outDir = path.dirname(resultPath);
  const summary =
    result.diagnostics[0] ??
    result.build.blockedReason ??
    result.devices.find((device) => device.status !== "passed")
      ?.blockedReason ??
    "matrix_failed";
  const lines = [
    `Runner failed: ${summary}`,
    `Log: ${path.resolve(outDir, result.artifacts.commandLog)}`,
    `Result: ${resultPath}`,
  ];
  console.error(lines.join("\n"));
}

function compactTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
