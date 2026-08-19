import type { RegisteredRule } from "../../types/ruleTypes.js";
import type { CollectedEvidence } from "../../evidence/types.js";
import type { EvaluatedRule } from "../shared.js";

// 结构类规则预留统一入口，后续接目录或文件约束时无需再回退到旧体系。
export function runProjectStructureRule(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const requiredPaths = (rule.detector.config.requiredPaths as string[] | undefined) ?? [];
  const workspacePaths = new Set(evidence.workspaceFiles.map((item) => item.relativePath));
  const missingPaths = requiredPaths.filter((item) => !workspacePaths.has(item));

  return {
    rule_id: rule.rule_id,
    rule_source: rule.rule_source,
    result: missingPaths.length > 0 ? "不满足" : "满足",
    conclusion:
      missingPaths.length > 0
        ? `${rule.summary} 缺失路径：${missingPaths.join(", ")}`
        : "项目结构符合该规则要求。",
    matchedFiles: missingPaths,
  };
}
