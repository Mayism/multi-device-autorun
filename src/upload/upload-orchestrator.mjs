// upload-orchestrator.mjs
// 可复用的上传编排：对批次中的失败用例打包并上传到 AGC 云存储。
// 被 src/upload-results.mjs（CLI）和 batch-report.mjs（自动集成）共用。

import fs from "node:fs/promises";
import path from "node:path";
import { createZip } from "../shared/zip.mjs";
import { uploadBytes, UPLOAD_CONFIG } from "./uploader.mjs";

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

function caseNeedsUpload(summaryResult, caseOhosResult) {
  // 整体状态不是 completed → 需要上传（Agent 失败、超时、中断等）
  const status = String(summaryResult?.status || "").toLowerCase();
  if (status && !["completed", "skipped", "cancelled"].includes(status)) return true;
  // 测试结果中有失败/错误 → 需要上传
  if (caseOhosResult) {
    const devices = caseOhosResult.run?.devices || [];
    if (devices.some((d) => (Number(d.failures) || 0) > 0 || (Number(d.errors) || 0) > 0)) return true;
  }
  return false;
}

/**
 * 对批次中的失败用例打包上传。
 * @param {object} options
 * @param {string} options.batchRoot — 批次目录
 * @param {object} options.summary — summary.json 内容
 * @param {object} options.report — report.json 内容（用于判断哪些用例有失败）
 * @param {object} options.uploadConfig — upload 配置
 * @param {function} [options.onLog] — 日志回调
 * @returns {Promise<object>} upload-results 映射 { caseName: { url, error, uploadedAt } }
 */
export async function uploadFailedCases({ batchRoot, summary, report, enabled = false, onLog }) {
  const log = onLog || (() => {});
  const uploadConfig = UPLOAD_CONFIG;
  const results = {};
  const batchId = summary?.batchId || path.basename(batchRoot);
  const prefix = uploadConfig.prefix || "ohostest";

  const ohosByCase = new Map((report?.ohosTest?.caseResults || []).map((c) => [c.case, c]));

  // 读已有 upload-results.json（增量上传，跳过已成功的）
  const resultsPath = path.join(batchRoot, "upload-results.json");
  let existing = {};
  try { existing = JSON.parse(await fs.readFile(resultsPath, "utf8")) || {}; } catch { existing = {}; }

  const allResults = Array.isArray(summary?.results) ? summary.results : [];

  for (const result of allResults) {
    const caseName = result.case;
    if (existing[caseName]?.url) {
      results[caseName] = existing[caseName];
      log(`${caseName}: 已上传，跳过`);
      continue;
    }
    if (!caseNeedsUpload(result, ohosByCase.get(caseName))) {
      log(`${caseName}: 无失败/错误，跳过`);
      continue;
    }

    const caseDir = path.join(batchRoot, caseName);
    if (!await exists(caseDir)) {
      log(`${caseName}: 用例目录不存在，跳过`);
      continue;
    }

    // 收集要打包的目录
    const sources = [];
    for (const [dir, pfx] of [
      [".ohostest-runs", ".ohostest-runs"],
      ["base", "base"],
      ["task", "task"],
      ["diff", "diff"],
    ]) {
      const fullDir = path.join(caseDir, dir);
      if (await exists(fullDir)) sources.push({ dirPath: fullDir, prefix: pfx });
    }
    // base 和 task 只取一个
    const hasBase = sources.some((s) => s.prefix === "base");
    if (hasBase) {
      const taskIdx = sources.findIndex((s) => s.prefix === "task");
      if (taskIdx >= 0) sources.splice(taskIdx, 1);
    }

    if (!sources.length) {
      results[caseName] = { url: "", error: "无可打包目录", uploadedAt: new Date().toISOString() };
      continue;
    }

    const zipName = `${caseName}_${batchId}.zip`;
    const localZipPath = path.join(caseDir, zipName);

    try {
      log(`${caseName}: 打包 ${sources.length} 个目录...`);
      const zipData = await createZip(sources);
      // 始终保存 zip 到用例目录
      await fs.writeFile(localZipPath, zipData);
      const sizeMB = (zipData.length / 1024 / 1024).toFixed(1);
      log(`${caseName}: ${sizeMB} MB → ${localZipPath}`);

      if (enabled) {
        const objectName = `${prefix}/${zipName}`;
        log(`${caseName}: 上传 ${objectName}`);
        const uploadResult = await uploadBytes(uploadConfig, zipData, objectName, log);
        results[caseName] = { url: uploadResult.url, error: "", uploadedAt: new Date().toISOString() };
        log(`${caseName}: ✓ ${uploadResult.url}`);
        // 仅上传模式下写 upload-results.json
        await fs.writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
      } else {
        log(`${caseName}: ✓ 已保存到本地（上传未开启）`);
      }
    } catch (error) {
      results[caseName] = { url: "", error: error.message, uploadedAt: new Date().toISOString() };
      log(`${caseName}: ✗ ${error.message}`);
    }

    // 每个用例后立即写文件（防中断丢失）
    await fs.writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  }

  return results;
}
