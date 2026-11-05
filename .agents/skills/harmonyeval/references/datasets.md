# 用例集与任务配置

## 配置如何选实现

顶层 `dataset.type` 选择用例适配器，`target.type` 选择被测对象，并激活 YAML 中的同名块。这个块包含 `rounds`、`execution`、`verification`、`scoring` 和 `report`。`scenario` 是场景标签，不能据此创建另一条框架流水线。

当前内置类型（扩展 entry points 还可以注册新类型）：

| 层 | 注册名 |
|---|---|
| dataset | `swe-bench-hm-multi-dev`、`library-migration`、`android-migration`、`text-qa` |
| target | `skills`、`plugin_agent`、`harmonybot_agent`、`opencode_agent`、`knowledge`、`http_agent` |
| execution.engine | `opencode`、`http` |

`knowledge`/`http_agent` 使用 HTTP 执行智能问答；`knowledge_agent` 尚未实现。工程类和 OpenCode 文本问答复用 OpenCode engine。

- 主入口是 `harmonyeval run <task.yaml>`；schema_version 当前为 `2`。
- 仓库任务统一放在 `scenarios/<scenario>/`，子目录使用 YAML `scenario` 标签对应的小写短横线形式；通用模板以 `*.example.yaml` 命名。场景使用的 JSON、rubric、题集和工具配置放在对应场景目录；共享资料保留一份，由其他场景通过相对路径引用。移动 YAML 时修正相对路径，保留 Plugin entry 相对于 target.dir 的语义；不改 loader 去硬编码场景位置。
- `execution.agent_name` 指实际注册的 Agent ID。被测 Plugin 由 `target` 装载，不重复放入 plugin_agent 的 `execution.opencode.plugins`。
- 被测 Skill/Plugin 的 `execution.without_enable: true` 启用一次任务的 without+with 对照；false/省略只跑 with，只支持 `skills`/`plugin_agent`。Plugin 的 without 组默认使用 build，可用 without_agent_name 指定；Skill 默认沿用相同 Agent。MCP 的完整定义放在 OpenCode JSON，通过 `execution.opencode.config_path` 加载；同一任务比较可用 `experiments` 覆盖指定 MCP 的 enabled。
- 对照应保持同一用例、提示词、Agent、模型和评分规则，明确唯一变化的能力。不要为 Agent 本身评测自动构造“没有 Agent”的对照。
- 工具链路径字段拼写为 `execution.enviroment`，例如 `deveco_home`、`flutter_home`；不要新增 `runtime_config`/`execution.runtime`。
- 内置路径字段相对于 YAML 所在目录解析；新增字段不会自动获得路径规范化。模型密钥填写环境变量名，不写入 Skill 或示例。
- 当前 `static_eval` 通过独立包调用两个 wheel，对显式 Skill 集合执行任务级静态质量与安全 LLM 评估，与主评测并行且每批一次；空对象关闭。model、skill_roots、checks、timeout、concurrency 的实现见 static_eval/ 和实现文档第9节。迁移其他仓库时保留原有静态评测口径，不能自动变成逐用例验证。

具体配置从仓库 `scenarios/<场景名>/*.example.yaml` 选择相近场景，再查 `config/loader.py`、`agent/targets/` 和 `experiments/config.py`；这些源码路径均在 `harmonyeval/` 下。完整字段枚举在 `docs/harmony-eval-task-examples.md` 维护，不复制真实配置里的私密参数。

## 三种现有数据布局

### 一多适配

```text
cases/<case_id>/
  PROMPT.md
  base/                    # 或受支持的 task/ 工程布局
  metadata.json
  test_patch.patch
  golden_patch.patch
```

适配器为 `benchmarks/multidev.py`，保留其设备套件元数据与工程布局处理。test/golden patch 用于评估，Agent 结束后归档；不能提前复制到 Agent 工作工程或拼进任务提示词。

### 三方库 / Android 迁移

默认 `layout: cases`：

```text
cases/<case_id>/
  case.yaml
  PROMPT.md
  source/                  # 待转换库或应用
  grading/                 # 评估侧资料
```

`case.yaml` 最小示例：

```yaml
id: example_library
input:
  project: source
  instruction: PROMPT.md
expected:
  tests: grading
```

可选 `input.target_template` 提供目标模板；原工程副本放在目标工程的相邻 `input/`。没有模板则从原工程副本开始。最终目标工程根统一为该用例的 `base/`，产物类型由提示词约定，不能恢复 `expected.output_kind`/`expected.output_project` 或共享可写输出目录。

也支持 `dataset.layout: repositories`，直接读取库仓库目录；此时用 `dataset.instruction` 指定共同任务要求，`dataset.expected`/`dataset.verification` 可提供共用评估配置。原工程具有特定目录布局时优先检查 `benchmarks/migration.py` 的识别规则。

`expected.tests`/`api_mapping` 是评估侧资料路径，不会自动变成功能判据。API 数量一致性可由 `LibraryAPICount` 产生指标，但不证明接口语义或行为兼容。

### 文本问答

`text-qa` 可读单个 JSON/JSONL 文件或目录；JSON 支持数组或 `{"cases": [...]}`。

```json
[
  {
    "id": "qa_001",
    "question": "待评测的问题",
    "reference_answer": "标准答案",
    "criteria": {"required_points": ["必须覆盖的事实"]},
    "metadata": {"category": "example"}
  }
]
```

`id`/`question` 必须是非空字符串；也可使用 `reference_answers` 字符串数组表示多个可接受答案，通常只保留单复数一种写法。`reference_documents` 可指定评估参考资料，路径相对数据文件所在目录。`criteria` 的解释由选用验证器约定，不能假设任意 JSON 字段都被评分。

HTTP 智能客服与 OpenCode 有无 MCP 可共享同一份 JSON。公开输入只含 `case_id` 和 `question`，不得发送标准答案、私有 rubric 或参考补丁给被测 Agent。

## 新增数据格式

先判断现有布局能否表达；需要新格式才新增 DatasetLoader。推荐继承 `harmonyeval.benchmarks.base.DatasetAdapter` 复用准备与指纹逻辑，实现 `load(config) -> list[EvalCase]`，并使用 `select(cases, config)` 做选择、重复 ID 和空集校验。

需要核对的方法：

| 方法 | 责任 |
|---|---|
| `load(config)` | 把输入归一成 `EvalCase(case_id, question, root, project, expected, metadata)` |
| `prepare(case, workspace)` | 复制公开工程，剔除评估侧资料；返回准备结果 |
| `project_path(case, workspace)` | 指明实际目标工程根；特殊组合布局需要覆写 |
| `fingerprint(case)` | 反映公开提示词、输入工程和目标模板变化 |
| `evidence_fingerprint(case)` | 反映标准答案、判据、私有补丁等变化 |
| `archive_evidence(case, output)` | 可选，在 Agent 结束后归档评估资料 |

基类只隔离已知受保护路径；添加新的私有资料字段时，应同时处理复制过滤、证据指纹和归档，不能仅往 `metadata` 塞字段。文件准备隔离不等于禁止 Agent 跨目录读取。

扩展包通过 `[project.entry-points."harmonyeval.datasets"]` 注册，左侧名称与 `dataset.type` 一致。沿用验证/评分参考中的平铺包安装方式；新类不要再重复使用内置 registry 装饰器。加载器 schema/validate 应验证自己的字段，不要求修改主框架中的场景枚举。
