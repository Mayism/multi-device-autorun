import fs from "node:fs/promises";
import path from "node:path";
import { createZip } from "./zip.mjs";
import { OMITTED_GENERATE_FILES, TRANSIENT_CASE_FILES } from "./cleanup-case-metadata.mjs";

export async function archiveCases({ batchRoot, summary, onLog = () => {} }) {
  const batchId = summary?.batchId || path.basename(batchRoot);
  const archived = [];
  for (const result of Array.isArray(summary?.results) ? summary.results : []) {
    const caseName = result.case;
    const caseDir = path.join(batchRoot, caseName);
    if (!await fs.stat(caseDir).then((stat) => stat.isDirectory(), () => false)) {
      onLog(`${caseName}: 用例目录不存在，跳过`);
      continue;
    }
    const zipPath = path.join(caseDir, `${caseName}_${batchId}.zip`);
    try {
      const excludeAbsPaths = new Set([
        zipPath,
        ...TRANSIENT_CASE_FILES.map((name) => path.join(caseDir, name)),
        ...OMITTED_GENERATE_FILES.map((name) => path.join(caseDir, "generate", name)),
      ].map((filePath) => path.resolve(filePath)));
      const zipData = await createZip(
        [{ dirPath: caseDir, prefix: "" }],
        { excludeAbsPaths },
      );
      await fs.writeFile(zipPath, zipData);
      archived.push(zipPath);
      onLog(`${caseName}: 本地 ZIP 已保存 → ${zipPath}`);
    } catch (error) {
      onLog(`${caseName}: 打包失败: ${error.message}`);
    }
  }
  return archived;
}
