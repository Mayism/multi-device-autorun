---
name: hmos-rubric-scoring
description: Use when scoring generated HarmonyOS/OpenHarmony code with rubric_summary items and scoring_payload context, especially when the output must be the strict rubric-scoring JSON written to output_file.
---

# hmos-rubric-scoring

## 角色与目标

担任 HarmonyOS / OpenHarmony 代码生成结果的 rubric 评分员。只基于 sandbox 内可见文件、`scoring_payload`、`rubric_summary.dimension_summaries` 和用户指定的 `output_file` 完成评分。

核心目标：

- 对每个 rubric item 给出可复核、可解释、符合档位的分数。
- 必须基于真实代码证据评分，不凭空推断问题。
- 输出严格 JSON，并写入指定文件。

正确输出格式：

```json
{
  "summary": {
    "overall_assessment": "中文总体评价",
    "overall_confidence": "high"
  },
  "item_scores": [
    {
      "dimension_name": "rubric 维度名",
      "item_name": "rubric 评分项名",
      "score": 40,
      "max_score": 40,
      "matched_band_score": 40,
      "rationale": "中文说明评分依据",
      "evidence_used": ["generated/entry/src/main.ets"],
      "confidence": "high",
      "review_required": false,
      "deduction_trace": {
        "code_locations": ["generated/entry/src/main.ets:12"],
        "impact_scope": "影响范围",
        "rubric_comparison": "未命中更高档，因为...；命中当前档，因为...",
        "deduction_reason": "扣分原因",
        "improvement_suggestion": "最小修复建议"
      }
    }
  ],
  "hard_gate_candidates": [
    {
      "gate_id": "G1",
      "triggered": false,
      "reason": "中文说明",
      "confidence": "high"
    }
  ],
  "risks": [
    {
      "level": "low",
      "title": "风险标题",
      "description": "风险描述",
      "evidence": "证据摘要",
      "risk_code": "TAXONOMY_CODE",
      "risk_category": "low"
    }
  ],
  "strengths": ["优势"],
  "main_issues": ["主要问题"]
}
```

## 执行顺序

按以下顺序执行，不要跳步：

1. 读取 `scoring_payload`，确认任务目标、rubric、hard gate 候选、默认或指定的 `output_file`。
2. 读取 `patch/effective.patch`，先理解实际变更范围；不要从预设目标文件列表开始泛读。
3. 根据 patch 中的文件路径读取相关 `generated/` 或 `original/` 上下文。changed files 很多时，结合 `workspace_project_structure` 选择代表性文件取证。
4. 按 HarmonyOS / OpenHarmony 应用工程语境审查实现质量。
5. 覆盖 `rubric_summary.dimension_summaries` 中每一个 `dimension_name + item_name`，逐项匹配 scoring band。
6. 对扣分项补全 `deduction_trace`；满分项不要编造扣分链路。
7. 输出 `risks` 前读取 `references/risk-taxonomy.yaml`，只从 `score_taxonomy` 选择风险；每个风险必须填写稳定 `risk_code`；`review_only_taxonomy` 只用于人工复核语义，不能进入 `risks`。
8. 执行输出前自检，将最终 JSON object 写入 `output_file`。
9. assistant 最终回复只返回 `{"output_file":"..."}`。

## HarmonyOS 审查重点

评分时必须优先按鸿蒙工程语境理解代码，重点检查：

- ArkTS / ArkUI：空值处理、生命周期、状态管理、组件声明、装饰器、事件绑定、资源引用、路由导航、异步调用和模块导入。
- Kit / API：导入路径、权限与能力声明、调用时机、参数类型、错误处理、回调或 Promise 流程、设备能力适配和 API 版本兼容性。
- 功能链路：入口可达性、用户用例闭环、交互状态、数据流、异常分支、空状态和边界场景。
- 工程完整性：构建配置、资源路径、模块边界、依赖声明、平台能力与实现代码是否一致。

## 评分规则

必须满足以下约束：

- 每个 rubric item 恰好输出一次，不能新增、遗漏或重复。
- 每个 `score` 必须来自该 item 的 `scoring_bands.score`。
- `matched_band_score` 必须与 `score` 相同。
- `max_score` 必须等于该 item 的 `weight`。
- 无充分负面证据时保持满分；可降低 `confidence` 或设置 `review_required=true`，不得保守扣分。
- `rationale` 必须说明为什么命中当前档位，且要结合完整功能链路，不要只描述孤立代码片段。
- 扣分项必须提供完整 `deduction_trace`，包括代码位置、影响范围、rubric 档位对比、扣分原因和最小修复建议。
- 满分项通常不输出 `deduction_trace`；不要为了格式完整而虚构问题。

## 证据规则

- `evidence_used` 只能填写 sandbox 内文件相对路径，不能带行号。
- `deduction_trace.code_locations` 可以填写带行号的位置。
- 在 `deduction_trace.code_locations`、`rationale`、`risks[].evidence` 或其他证据说明中包含行号时，必须使用 `generated/` 工程文件中的真实行号。
- `patch/effective.patch` 只用于定位变更，禁止使用 patch hunk 行号作为证据行号。
- 如果需要比较改动前后行为，可同时读取对应 `original/` 文件，但结论仍要落到 `generated/` 代码证据。

## 风险输出规则

### 归并规则

- 只从 `score_taxonomy` 选择 `risk_code`；`review_only_taxonomy` 不得进入 `risks`。
- 若确有风险事实但无法稳定归入现有分类，只能使用 `OTHER_ISSUE`，并保持标题为 `其他问题`；不要自造 `risk_code` 或自由标题。
- 同一组代码位置、同一条证据链、同一个根因只输出一个风险。
- 每个风险只保留一个主落点，不要把同一根因拆成需求、接口、平台、状态、异常等多个近义风险。
- 规则违规类风险由规则融合阶段生成；rubric agent 不要用自由风险重复表达同一条规则编号已经覆盖的事实。
- 如果规则融合阶段会覆盖同一事实，rubric 风险只保留独立于规则的运行时、数据流、状态、异常处理或平台约束后果。



### 风险 taxonomy 判定优先级

输出 `risks` 时按以下优先级选择唯一主落点，避免同一事实被拆成多个近义风险：

1. 如果同一事实已由 rule agent 以同一代码位置、同一失败机制、同一 canonical code 覆盖，rubric agent 不再输出重复自由风险。
2. 若规则、需求或用例明确指定 Kit/API/组件/调用方式，且代码没有真实 import、符号调用或可追溯到 Kit/API 的封装，归入 `API_USAGE_DEVIATION`。Axios、HTTP endpoint、本地同名函数、静态占位、Mock、自绘或静态图标不能等价为指定 Kit/API/组件。
3. 若核心功能链路完全不可用或关键能力完全缺失，归入 `REQUIREMENT_NOT_IMPLEMENTED`。
4. 若功能已有部分实现但交互分支、边界场景、状态同步、兜底逻辑或核心链路存在缺口，归入 `REQUIREMENT_PARTIALLY_IMPLEMENTED`。
5. 若问题主要来自断点、窗口形态、浅层窗口、半模态、折叠屏、悬停态、Web/Native 断点同步或组件响应式参数，归入 `UI_LAYOUT_OR_BREAKPOINT_MISMATCH`。
6. 若问题主要来自导航栈、popup 状态、弹窗状态、缓存、持久化、全局状态或页面栈同步，归入 `DATA_STATE_CONSISTENCY_RISK`。
7. 若问题主要来自异常静默吞没、输入校验、失败反馈、确认机制或仅 return 拦截，归入 `ERROR_HANDLING_OR_VALIDATION_RISK`。

对于浅层窗口、导航栈、弹窗状态等交叉问题，先判断是否为明确需求缺失，再判断是否为状态一致性，最后判断是否为布局/断点参数偏差。

### 输出阈值

候选风险必须至少满足以下条件之一，才可进入 `risks`：

- 对应明确扣分项的 `deduction_trace`。
- 有真实 `generated/` 代码位置和可复核后果。
- 触发 hard gate 候选。
- 会导致功能链路、数据状态、异常处理、安全隐私、外部服务集成或平台约束出现明确问题。

以下内容默认不进入 `risks`，应写入 `rationale`、`main_issues` 或扣分说明：

- 低置信度推测。
- 轻微风格或命名问题。
- 局部可读性问题。
- 轻微重复代码。
- 可能但未证实的性能问题。
- 不影响功能链路、构建、平台约束或用户可见行为的局部实现偏好。

### 输出字段规则

- 每个风险必须包含稳定 `risk_code`，且只能来自 `score_taxonomy`。
- `level` 和 `title` 必须与 `risk_code` 对应的 taxonomy 条目完全一致。
- `risk_category` 应与 taxonomy 的 `level` 相同。
- `description` 说明风险后果，不要只复述代码现象。
- `evidence` 给出可复核证据摘要；如包含行号，必须使用 `generated/` 工程文件真实行号，不要使用 patch hunk 行号。

## 输出语言与 JSON 约束

只输出一个 JSON object，不要 Markdown、代码块、解释文字或自然语言前后缀。最终 JSON 的第一个非空字符必须是 `{`，最后一个非空字符必须是 `}`。

字段约束：

- JSON 字段必须完全符合“正确输出格式”，不能增加额外字段，不能替换字段名。
- 不要输出 `total_score`、`item_id`、`reason`、`risk_level`、`message` 等未声明字段。
- `risks` 必须是 array；每项必须包含 `level`、`title`、`description`、`evidence`、`risk_code` 五个 string 字段，可额外包含 `risk_category`、`source_rule_id`。
- `risk_category` 只能是 `low`、`medium`、`high` 之一；如果输出 `risk_code` 且已匹配 taxonomy，`risk_category` 应与 taxonomy 的 `level` 相同。
- 除 JSON 字段名、枚举值、分类标签、文件路径、代码标识符和原始专有名词外，所有文案类内容必须使用中文。
- 面向评测结论、原因、摘要、建议、风险、优势、问题、证据说明的字符串字段都必须用中文表达。
- JSON 字符串中的英文双引号必须转义；如果必须引用原文，先改写为不含双引号的中文转述再写入字段。

## 文件输出协议

- 必须将最终 JSON object 写入用户消息指定的 `output_file`。
- 如果用户没有指定，默认写入 `metadata/agent-output/rubric-scoring.json`。
- 写入 `output_file` 的内容必须是完整 JSON object，不能包含 Markdown、解释文字或代码块。
- 写入文件后，assistant 最终回复只能是 `{"output_file":"<实际输出路径>"}`。
- 不要在最终回复中重复完整结果 JSON。

## 输出前自检

提交前逐项确认：

- 每个 rubric item 恰好出现一次。
- 每个 `score` 均来自对应 item 的允许分值。
- `matched_band_score == score`，`max_score == weight`。
- 每个扣分项都有完整 `deduction_trace`；满分项没有虚构扣分链路。
- `evidence_used` 只有文件路径、没有行号。
- 带行号的证据使用 `generated/` 工程文件真实行号，没有使用 patch hunk 行号。
- 已按 HarmonyOS / OpenHarmony 语境检查 ArkTS / ArkUI、Kit / API、权限能力声明、生命周期、状态、路由、资源、异步流程和 API 兼容性。
- 已结合用户用例或任务目标检查功能完备度、流程闭环、入口可达性、交互状态、数据流、异常和空状态处理。
- `rationale`、`overall_assessment`、`main_issues` 给出基于完整功能链路的评分依据。
- 已读取 `references/risk-taxonomy.yaml`，且只从 `score_taxonomy` 输出风险。
- 没有把 `review_only_taxonomy` 条目写入 `risks`。
- 每个风险都包含来自 `score_taxonomy` 的稳定 `risk_code`，且 `level`、`title` 未被改写；无法归类时使用 `OTHER_ISSUE`。
- 已合并同根因、同证据链、同代码位置的近义风险，并只保留一个主落点。
- 已避免重复输出规则融合阶段会生成的规则违规风险。
- 已将低置信度、轻微风格或未证实问题留在评分说明中，而不是放入 `risks`。
- 文案类字符串均为中文；英文枚举值、文件路径、代码标识符和原始专有名词除外。
- JSON 字符串中的英文双引号均已转义，或已改写为不含双引号的中文转述。
- 没有额外字段、Markdown、代码块或自然语言前后缀。
- JSON 语法完整，所有 `{}`、`[]`、字符串和逗号都正确闭合。
