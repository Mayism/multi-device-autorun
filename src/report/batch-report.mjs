import fs from "node:fs/promises";
import path from "node:path";
import { runPythonWorker } from "../runtime/python-worker.mjs";
import { writeHtmlReport } from "./html-report.mjs";

// Merge reports still call this synchronous helper. Batch report data is computed in Python.
export function buildWhiteboxSummary(results, enabled) {
  const cases = results
    .filter((item) => item?.whitebox)
    .map((item) => ({ case: typeof item.case === "string" ? item.case : "", ...item.whitebox }));
  const scores = cases
    .map((item) => Number(item.totalScore))
    .filter((value) => Number.isFinite(value));
  return {
    enabled: enabled === true,
    completed: cases.filter((item) => item.status === "completed").length,
    failed: cases.filter((item) => item.status !== "completed").length,
    averageScore: scores.length
      ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 100) / 100
      : null,
    cases,
  };
}

export async function writeBatchReport({ batchRoot, summary, uploadConfig, onLog = () => {} }) {
  const bytes = await runPythonWorker("batch-report", {
    summary,
    generatedAt: new Date().toISOString(),
  });
  const report = JSON.parse(bytes.toString("utf8"));
  const jsonPath = path.join(batchRoot, "report.json");
  await fs.rm(path.join(batchRoot, "report.md"), { force: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  try {
    const { uploadFailedCases } = await import("../artifacts/upload-orchestrator.mjs");
    await uploadFailedCases({ batchRoot, summary, report, enabled: uploadConfig?.enabled === true, onLog });
  } catch (error) {
    onLog(`批量打包/上传失败: ${error.message}`);
  }
  const html = { overviewPath: "", subpageDir: "" };
  try {
    const result = await writeHtmlReport({ batchRoot, summary });
    html.overviewPath = result.overviewPath;
    html.subpageDir = result.subpageDir;
  } catch (error) {
    html.error = error.message;
  }
  return { jsonPath, htmlOverviewPath: html.overviewPath, htmlError: html.error };
}
