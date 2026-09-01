import fs from "node:fs/promises";
import path from "node:path";
import { validateReportResult } from "../../../report/resultSchemaValidator.js";
import { emitNodeFailed, emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import type { ScoreGraphState } from "../../graph/state.js";
import { buildReportResultJson } from "./tools.js";

/** 报告生成节点：组装 result.json 并按官方 schema 做最终校验。 */
export async function reportGenerationNode(
  state: ScoreGraphState,
  config: { referenceRoot: string },
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("reportGenerationNode");
  try {
    const schemaPath = path.join(config.referenceRoot, "report_result_schema.json");
    const schemaText = await fs.readFile(schemaPath, "utf-8");
    const schema = JSON.parse(schemaText) as object;
    if (typeof schema !== "object" || schema === null) {
      throw new Error("report_result_schema.json 内容不合法。");
    }

    const resultJson = buildReportResultJson(state);
    validateReportResult(resultJson, schemaPath);
    return { resultJson };
  } catch (error) {
    emitNodeFailed("reportGenerationNode", error);
    throw error;
  }
}
