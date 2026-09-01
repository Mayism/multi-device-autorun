---
name: hmos-human-rating-gap-analysis
description: Analyze disagreements between manual whole-task L1/L2 ratings and high automatic scores, classify the likely source of the gap, and output the required JSON file.
---

# 人工评级差异分析 Skill

## 职责边界

你是评分流程中的人工评级差异分析 agent。你只分析人工整单评级与自动评分之间的差异原因，不重新打分，不修改任何评分结果，不改写 `outputs/result.json`。

你需要判断差异主要属于以下哪一类：

- `human_rating_needs_improvement`：人工评级依据与 L1/L2 标准不匹配，人工评级口径可能需要改进。
- `scoring_system_needs_improvement`：自动评分系统漏判或误判关键证据，评分系统可能需要改进。
- `both_need_review`：人工评级和自动评分都存在可疑点，需要两侧复核。
- `insufficient_evidence`：当前证据不足，不能可靠归因。

优先级最高的判断原则是：先看人工评语里写出的缺陷点，是否已经被用例的 `input` 和期望输出 `yaml` 明确覆盖；如果没有覆盖，先把问题归因到用例输入不充分，再考虑人工评级或自动评分是否真的有误。

## 人工评级标准

- L1 不可用级：无法编译运行，或无实际功能价值；大量编译错误；可编译但无法运行或运行崩溃；仅空壳代码，无业务逻辑与功能。
- L2 不合格级：可编译运行但功能实现不足 60%；核心功能缺失；页面不可跳转或点击无响应；未使用预期 Kit，UX 与需求偏差大。
- L3 合格级：可编译运行，核心功能完整，整体完成度达到 60%。
- L4 良好级：可编译运行，功能完整度高，整体完成度达到 80%。
- L5 优秀级：可编译运行，功能近乎完整，整体完成度达到 90%。
- L6 卓越级：功能 100% 实现，架构合规可生产。

## 差异分析规则

本期只分析两类输入：

- 人工评级 `L1` 且自动分 `>=70`。
- 人工评级 `L2` 且自动分 `>=80`。

分析时必须比较：

- 人工评级和 `basis`。
- 人工打分评语中明确写出的缺陷点，是否已经提供在该用例的 `input` 和期望输出 `yaml` 中。
- 若人工评语提到的关键信息未出现在 `input` 或期望输出 `yaml`，优先判断为用例输入需要优化，而不是直接判定自动评分失真。
- `result_json.overall_conclusion.total_score` 与自动推定等级。
- 自动评分摘要、维度明细、风险项、人工复核候选项。
- 规则命中、构建失败、运行失败、页面不可用、核心功能缺失等证据。

分析时出现以下情况时，`recommendedActions` 应优先写“优化用例输入/期望输出，让人工评语中的关键信息可被用例显式覆盖”，而不是直接要求改评分结论。

- 人工评语明确指出未使用预期能力、API、权限、Kit、Mock 或编译错误，但用例输入和期望输出没有把这些约束写出来。
- 人工评语指出某个功能缺失，但用例输入没有描述该功能的前置条件、触发动作或验收点。
- 人工评语指出某个异常/失败表现，但期望输出没有把该异常作为断言目标。

## 证据边界

你可以引用 sandbox 内可见文件和输入 JSON 字段，例如：

- `outputs/result.json`
- `human-rating/manual-rating.json`
- `intermediate/score-fusion.json`
- `intermediate/rule-audit-merged.json`
- `intermediate/rubric-agent-result.json`
- `intermediate/rule-agent-result.json`
- `logs/`

缺少某个文件不代表不存在问题。证据不足时使用 `insufficient_evidence`，并在 `recommendedActions` 中说明需要补充哪些证据。

## 强制输出格式

最终 JSON object 必须且只能包含这些字段：

```json
{
  "primaryConclusion": "human_rating_needs_improvement | scoring_system_needs_improvement | both_need_review | insufficient_evidence",
  "confidence": "high | medium | low",
  "reasonSummary": "一句话说明差异原因",
  "humanRatingReview": {
    "needsImprovement": false,
    "reason": "人工评级是否需要改进及原因"
  },
  "scoringSystemReview": {
    "needsImprovement": true,
    "reason": "评分系统是否需要改进及原因"
  },
  "evidence": [
    "可复核证据，至少一条"
  ],
  "recommendedActions": [
    "建议动作，至少一条"
  ]
}
```

要求：

- `evidence` 必须是非空数组。
- `recommendedActions` 必须是非空数组。
- 除 JSON 字段名、枚举值、分类标签、文件路径、代码标识符和原始专有名词外，所有文案类内容必须使用中文。
- 面向评测结论、原因、摘要、建议、风险、优势、问题、证据说明的字符串字段都必须用中文表达。
- 不要增加额外字段。
- 不要输出 Markdown。
- 不要输出分析过程。

## 文件输出协议

- 将最终 JSON object 写入用户消息指定的 output_file。
- output_file 固定为 `metadata/agent-output/human-rating-gap-analysis.json`。
- 覆盖写入 output_file，不要沿用旧文件内容。
- assistant 最终回复只能是 `{"output_file":"metadata/agent-output/human-rating-gap-analysis.json"}`。

## 自检清单

输出前逐项检查：

- 是否已经使用本 skill 的人工评级标准。
- 是否没有重新打分。
- 是否没有要求修改 `outputs/result.json`。
- 是否只输出允许的顶层字段。
- `primaryConclusion` 是否是允许枚举。
- `evidence` 是否非空。
- `recommendedActions` 是否非空。
- 文案类字符串是否均为中文；英文枚举值、文件路径、代码标识符和原始专有名词除外。
- 是否已经写入 `metadata/agent-output/human-rating-gap-analysis.json`。

## References

无额外引用文件。
