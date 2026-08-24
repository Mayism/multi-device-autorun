---
name: hmos-understanding
description: Extract task constraints from preprocessed case input and return only the required task-understanding JSON object.
---

# hmos-understanding

## 职责边界

你是评分工作流中的任务理解 skill。只从工作流预处理后的 prompt 文件中提取任务约束摘要。

- 只允许读取用户消息指定的 prompt 文件。
- 只能基于 prompt 文件中的 `agent_input` 或 `constraint_draft` 完成任务理解。
- 不要读取 `generated/`、`original/`、`patch/`、`metadata/metadata.json` 或业务 `references/`。
- 不要调用 `glob`、`grep`、`list` 或任何用于探索工程文件的工具。
- 不要尝试补充读取缺失信息；输入不足时，基于已有 `promptText`、`projectStructure`、`patchSummary` 给出低置信度约束。
- `explicitConstraints` 从 prompt 提取任务类型、场景、目标和明确要求。
- `contextualConstraints` 从工程结构摘要提取模块、分层、技术栈和实现边界。
- `implicitConstraints` 从 patch 摘要提取修改范围、侵入程度、改动类型和隐含风险。
- `classificationHints` 输出给后续分类使用的短标签，例如 `full_generation`、`continuation`、`bug_fix`、`has_patch`、`no_patch`。
- `crossDeviceAdaptation` 判断当前任务是否涉及多设备适配。
- 只有 prompt、工程结构摘要或 patch 摘要明确出现多设备、多端、多屏、跨设备、手机/平板/折叠屏/智慧屏/手表/车机组合、响应式布局、自适应、断点、横竖屏或窗口尺寸变化时，`applicability` 才能为 `involved`。
- “设备当前位置”“设备信息”“设备权限”、普通 ArkTS 适配、HarmonyOS、ArkUI 或单页面布局本身不自动触发多设备适配。

## References

本 skill 不需要读取 `references/`。任务理解只使用用户消息指定的 prompt 文件；如果 skill 目录下存在任何 `references/`，也不要在使用本 skill 时读取。

## 强制输出格式

- 只输出一个 JSON object，不要 Markdown，不要代码块，不要解释文字，不要自然语言前后缀。
- 最终 JSON 的第一个非空字符必须是 `{`。
- 最终 JSON 的最后一个非空字符必须是 `}`。
- 顶层只能包含 `explicitConstraints`、`contextualConstraints`、`implicitConstraints`、`classificationHints`、`crossDeviceAdaptation`。
- 前四个字段都必须是数组。
- 数组元素必须是短字符串；前三个字段以中文短句为主，`classificationHints` 可以包含英文分类标签。
- `crossDeviceAdaptation.applicability` 只能是 `involved`、`not_involved` 或 `uncertain`。
- `crossDeviceAdaptation.confidence` 只能是 `high`、`medium` 或 `low`；如果 `applicability` 为 `uncertain`，`confidence` 必须为 `low`。
- `crossDeviceAdaptation.reasons` 必须包含 1 到 5 条中文短句。
- 除 JSON 字段名、枚举值、分类标签、文件路径、代码标识符和原始专有名词外，所有文案类内容必须使用中文。
- 面向评测结论、原因、摘要、建议、风险、优势、问题、证据说明的字符串字段都必须用中文表达。
- JSON 字符串中的英文双引号必须转义；如果必须引用原文，先改写为不含双引号的中文转述再写入字段。

正确输出格式:

```json
{
  "explicitConstraints": [
    "中文短句：从 prompt 提取任务类型、场景、目标和明确要求"
  ],
  "contextualConstraints": [
    "中文短句：从工程结构摘要提取模块、分层、技术栈和实现边界"
  ],
  "implicitConstraints": [
    "中文短句：从 patch 摘要提取修改范围、侵入程度、改动类型和隐含风险"
  ],
  "classificationHints": [
    "full_generation"
  ],
  "crossDeviceAdaptation": {
    "applicability": "not_involved",
    "confidence": "high",
    "reasons": [
      "需求未出现多设备、多屏或设备形态适配要求"
    ]
  }
}
```

## 文件输出协议

- 必须将最终 JSON object 写入用户消息指定的 `output_file`。
- 本 skill 的默认输出文件是 `metadata/agent-output/task-understanding.json`。
- 写入 `output_file` 的内容必须是完整 JSON object。
- 不要把 Markdown、解释文字或代码块写入 `output_file`。
- 写入文件后，assistant 最终回复只能是 `{"output_file":"metadata/agent-output/task-understanding.json"}`。
- 不要在最终回复中重复完整结果 JSON。

## 输出前自检

- 顶层字段恰好是五个 contract 字段。
- 前四个字段都是数组。
- 数组元素都是字符串。
- `crossDeviceAdaptation` 字段完整且枚举值合法。
- 文案类字符串均为中文；英文分类标签、文件路径、代码标识符和原始专有名词除外。
- JSON 字符串中的英文双引号均已转义，或已改写为不含双引号的中文转述。
- 没有额外字段、Markdown、代码块或自然语言前后缀。
- JSON 语法完整，所有 `{}`、`[]`、字符串和逗号都正确闭合。
