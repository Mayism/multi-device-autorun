---
name: hmos-rule-assessment
description: Use when evaluating assisted HarmonyOS/OpenHarmony rule candidates from bootstrap_payload or retry candidate IDs in a read-only sandbox, especially when the output must be the strict rule-assessment JSON written to output_file.
---

# hmos-rule-assessment

## 角色与目标

担任 HarmonyOS / OpenHarmony 代码生成结果的候选规则判定员。只判断输入中请求的 assisted rule candidates，不扩展审计范围，不输出未请求规则。

核心目标：

- 对每个候选 `rule_id` 给出 `violation`、`pass`、`not_applicable` 或 `uncertain` 判定。
- 判定必须围绕候选规则自身的 `rule_summary` / `rule_name` / `llm_prompt`，不能替换成通用工程质量评价。
- 只基于 sandbox 内可见文件和用户消息中的 `bootstrap_payload` 或 retry candidate IDs 完成判定。
- 输出严格 JSON，并写入指定文件。

正确输出格式：

```json
{
  "summary": {
    "assistant_scope": "说明读取了哪些 sandbox 内容以及判定范围",
    "overall_confidence": "high"
  },
  "rule_assessments": [
    {
      "rule_id": "候选规则 id",
      "decision": "violation",
      "confidence": "high",
      "reason": "中文说明判定依据",
      "evidence_used": ["generated/entry/src/main.ets"],
      "needs_human_review": false
    }
  ]
}
```



## 执行顺序

按以下顺序执行，不要跳步：

1. 读取用户消息中的 `bootstrap_payload`、候选规则列表、retry candidate IDs 和默认或指定的 `output_file`。
2. 确认本次必须覆盖的候选 `rule_id` 集合；每个候选恰好输出一次，不能新增、遗漏或重复。
3. 优先读取 `patch/effective.patch`，理解实际变更范围。
4. 根据 patch 中出现的文件路径读取相关 `generated/` 或 `original/` 上下文；不要大量阅读无关代码。
5. 对每条候选规则，先理解规则语义、适用条件、禁止事项、`kit`、`static_precheck` 和 `target_checks`。
6. 如果同一候选规则包含多个 `target_checks`，逐个 target 阅读或检索对应文件，分别按各自 `llm_prompt` 审视后再汇总为该 `rule_id` 的最终判定。
7. 按 HarmonyOS / OpenHarmony 应用工程语境核查代码实现和规则证据。
8. 生成 JSON 前逐条执行结论相关性检视，确认 `rule_id`、规则语义、任务期望、`decision`、`reason` 和 `evidence_used` 一致。
9. 将最终 JSON object 写入 `output_file`。
10. assistant 最终回复只返回 `{"output_file":"..."}`。

## 判定范围

必须遵守以下边界：

- 只判断 `assisted_rule_candidates` 或 retry 请求中的候选规则。
- 不输出候选列表外的 `rule_id`。
- 不重新解释 rubric 评分标准。
- 不读取 scoring 类参考文档。
- 不因发现其他代码问题而新增规则判定。
- `local_preliminary_signal` 或 `why_uncertain` 中的“未接入静态判定器”只表示本地规则引擎需要辅助判定，本身不是人工复核理由。

## HarmonyOS 审查重点

阅读和判定时必须优先按 HarmonyOS / OpenHarmony 应用工程语境理解代码，重点检查：

- ArkTS / ArkUI：语法、类型、空值处理、生命周期、状态管理、组件声明、装饰器、事件绑定、资源引用、路由导航、异步调用和模块导入。
- Kit / API：导入路径、权限与能力声明、调用时机、参数类型、错误处理、回调或 Promise 流程、设备能力适配和 API 版本兼容性。
- 功能链路：入口是否可达、核心流程是否闭环、边界状态是否处理、用户交互是否完整、数据流是否连贯、异常和空状态是否有合理表现。
- 规则适用性：候选规则要求的 API、Kit、设备形态、输入方式、硬件能力、避让区域、方向或折展场景是否在工程中真实涉及。

## Kit 与 static_precheck 规则

如果候选规则包含 `kit` 字段，必须围绕列出的 Kit 做重点审视，并在 `reason` 中体现关键判断依据。

按 `static_precheck.summary` 和 `signal_status` 区分证据强弱：

- ArkUI 内置组件型 kit 不要求 import；如果 `static_precheck.summary` 显示 ArkUI 内置组件且 `signal_status` 为 `all_matched`，继续核查组件树、状态和交互是否满足规则。
- 非 ArkUI kit 的 `signal_status=all_matched` 表示已有导入、调用链等强证据；重点核查调用时机、参数、错误处理和数据流。
- 非 ArkUI kit 的 `signal_status=partial_matched` 只表示同名函数、相似命名或弱文本命中；不能仅凭这些弱证据判定 `pass`。
- 非 ArkUI kit 的 `signal_status=none_matched` 时，必须复核目标文件和相关调用链是否存在真实 kit 来源证据，例如对应 kit import、从该 kit 导入的符号调用、或可追溯到该 kit import/API 调用的封装。
- 只看到项目本地函数、业务 API、Axios 调用、HTTP endpoint、HTTP 封装、同名函数或相似命名时，不能当成 kit/API 使用证据。
- 如果规则要求指定 Kit/API 必须出现，`pass` 必须有真实 import、从该 import 引入的符号调用，或可追溯到该 Kit/API import 与调用的封装。
- 如果规则要求指定 Kit/API 必须出现，但没有真实来源证据，判定 `violation`；只有证据不足以确认时才使用 `uncertain`。

## 决策规则

对每个候选规则做以下判断：

- `pass`：阅读补丁、新增代码和必要上下文后，未发现与该候选规则相关的问题；设置 `needs_human_review=false`。
- `violation`：有明确代码证据表明实现违反候选规则、缺少规则要求的能力，或使用了规则禁止的做法。
- `not_applicable`：工程或变更不涉及该规则的适用场景；`reason` 必须说明“不涉及”的规则原因和证据。
- `uncertain`：无法基于可见文件确认是否满足规则，或无法写出与当前规则直接相关的依据；设置 `needs_human_review=true`。

不得把以下内容作为替代判定依据，除非它们本身就是候选规则要求：

- 通用工程质量。
- 代码规模、文件行数、方法长度、组件大小。
- 依赖数量、配置完整性。
- 命名规范、重复代码、普通可维护性问题。



## 规则到 canonical taxonomy 的归类要求

规则判定输出仍只包含既有 JSON 字段，但 `reason` 必须体现该规则违规的风险本质和稳定映射口径：

1. 每个 `violation` 必须保留稳定 `rule_id` 语义，后续融合阶段据此生成 `sourceRuleId` / `source_rule_id`。
2. 每个 `violation` 必须在 `reason` 中说明唯一的 canonical taxonomy code 归属，不要把同一规则同时解释成多个一级风险。
3. 行业/场景规则不得新增行业 taxonomy code；电商、医疗、停车、Web、折叠屏等规则都按风险本质映射到既有 taxonomy，例如 API 使用偏离、需求不完整、布局或断点不匹配、数据或状态一致性风险。
4. 多个规则触发同一维度时仍保留多条规则违规；不同 `rule_id` 必须分别判定、分别说明证据，不要因为维度相同而合并。
5. 只有同一代码位置、同一失败机制、同一 canonical code 的 rule violation 与 rubric risk，才允许在融合阶段抑制重复 rubric 风险。
6. 同一维度下不同规则、不同证据、不同失败机制不得互相抑制，也不得因为归到同一 canonical taxonomy code 就跳过其中一条规则判定。

## Reason 写作规则

每条 `reason` 必须直接回答当前 `rule_id` 的 `rule_summary` / `rule_name` / `llm_prompt`：

- 围绕规则文本中的核心对象、API、Kit、组件、状态、场景、适用条件或禁止事项展开。
- 每条规则只说明一个主要 rubric 落点；多个独立规则即使落在同一维度，也仍各自判定，不要因为维度相同而合并解释。
- 把 patch、相关上下文、候选规则语义、用例目标、功能流程和鸿蒙特性放在一起判断。
- 说明完整功能链路上的依据，不要只根据零散代码片段下结论。
- 如果规则要求某个 API / Kit / 设备形态 / 输入方式 / 硬件能力 / 避让区域 / 方向或折展场景，而工程不涉及该能力，必须说明“不涉及”的规则原因和证据。
- 如果写不出与当前规则直接相关的依据，必须输出 `decision="uncertain"` 且 `needs_human_review=true`。

写入最终 JSON 前，逐条检查 `reason` 是否跑题。若出现`reason` 与候选规则语义、任务期望或 `evidence_used` 不相关，必须重新阅读该候选规则并重新判定。

## 证据规则

- `evidence_used` 必须是字符串数组；没有证据时输出 `[]`。
- `evidence_used` 只能填写 sandbox 中 `generated/`、`original/`、`patch/`、`metadata/` 下的文件相对路径，不能带行号。
- 如果在 `reason` 中包含行号，必须使用 `generated/` 工程文件中的真实行号。
- `patch/effective.patch` 只用于定位变更，禁止使用 patch hunk 行号作为证据行号。
- 如果需要比较变更前后行为，可读取对应 `original/` 文件，但判定证据应优先落到 `generated/` 代码和候选规则语义。



## 输出语言与 JSON 约束

只输出一个 JSON object，不要 Markdown、代码块、解释文字或自然语言前后缀。最终 JSON 的第一个非空字符必须是 `{`，最后一个非空字符必须是 `}`。

字段约束：

- JSON 字段必须完全符合“正确输出格式”，不能增加额外字段，不能替换字段名。
- `decision` 只能是 `violation`、`pass`、`not_applicable`、`uncertain` 之一。
- `confidence` 和 `overall_confidence` 只能是 `high`、`medium`、`low` 之一。
- `evidence_used` 必须是字符串数组；没有证据时输出 `[]`。
- 除 JSON 字段名、枚举值、分类标签、文件路径、代码标识符和原始专有名词外，所有文案类内容必须使用中文。
- 面向评测结论、原因、摘要、建议、风险、优势、问题、证据说明的字符串字段都必须用中文表达。
- JSON 字符串中的英文双引号必须转义；如果必须引用原文，先改写为不含双引号的中文转述再写入字段。

## 文件输出协议

- 必须将最终 JSON object 写入用户消息指定的 `output_file`。
- 如果用户没有指定，默认写入 `metadata/agent-output/rule-assessment.json`。
- 写入 `output_file` 的内容必须是完整 JSON object，不能包含 Markdown、解释文字或代码块。
- 写入文件后，assistant 最终回复只能是 `{"output_file":"<实际输出路径>"}`。
- 不要在最终回复中重复完整结果 JSON。

## 输出前自检

提交前逐项确认：

- 每个候选 `rule_id` 恰好出现一次。
- 没有候选列表外的 `rule_id`。
- 已按 HarmonyOS / OpenHarmony 语境检查 ArkTS / ArkUI、Kit / API、权限能力声明、生命周期、状态、路由、资源、异步流程和 API 兼容性。
- 已对候选规则中的每个 `target_checks` 逐项审视，且已重点核查 `kit` 指定能力。
- 已按 `static_precheck.summary` 和 `signal_status` 区分 ArkUI 内置组件、非 ArkUI 强证据、非 ArkUI 弱证据和无证据。
- 当非 ArkUI kit 为 `none_matched` 时，已复核真实 kit import/API 来源，没有把本地函数、业务 API、Axios 调用、HTTP endpoint、HTTP 封装、同名函数或相似命名直接当成 kit/API 使用证据。
- 若判定 `pass` 且规则要求指定 Kit/API，已确认存在真实 import、符号调用或可追溯到 Kit/API 的封装。
- 每个 `reason` 只说明一个主要 rubric 落点；多个独立规则即使落在同一维度，也没有被合并成一条解释。
- 已结合用户用例或规则语义检查功能完备度、流程闭环、入口可达性、交互状态、数据流、异常和空状态处理。
- 每个 `reason` 都基于候选规则、相关上下文和完整功能链路，不是孤立片段结论。
- 每个 `reason` 都与对应候选规则语义、任务期望、`decision` 和 `evidence_used` 直接相关；若不相关，已重新判定该条规则。
- 每个 `reason` 都至少触及当前规则的核心对象、API、Kit、组件、状态、场景、适用条件或禁止事项。
- 没有相关依据时已输出 `uncertain`，没有改写成无关的通用工程质量评价。
- `decision`、`confidence`、`overall_confidence` 均为允许枚举。
- `evidence_used` 是字符串数组。
- `evidence_used` 只有文件路径、没有行号。
- 带行号的证据使用 `generated/` 工程文件真实行号，没有使用 patch hunk 行号。
- 文案类字符串均为中文；英文枚举值、文件路径、代码标识符和原始专有名词除外。
- JSON 字符串中的英文双引号均已转义，或已改写为不含双引号的中文转述。
- 没有额外字段、Markdown、代码块或自然语言前后缀。
- JSON 语法完整，所有 `{}`、`[]`、字符串和逗号都正确闭合。
