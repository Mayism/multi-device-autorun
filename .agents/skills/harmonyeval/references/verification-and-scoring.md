# 验证流程和评分器

## 先复用当前类型

| verification.type | 使用场景 |
|---|---|
| `Command` | 命令退出码代表验收结果，输出 `metrics.passed` |
| `LibraryTests` | 三方库验收命令的现有适配 |
| `LibraryAPICount` / `LibraryAPICompatibility` | API 数量或接口映射的不同层次检查，具体判据看实现 |
| `UITest` | 构建、设备执行、断言结果等整条验证流程 |
| `CloudTest` / `AGCDetection` | 云端测试/检测流程 |
| `LLM_judge` / `whiteboxeval` | 基于证据和判据的模型评价 |
| `ExactMatch` | 答案与标准字符串匹配 |
| `ToolUsage` | 配置、启用、尝试和成功调用工具的观测 |
| `SkillVerifier` | 使用独立 Skill 产出结构化评价 |
| `Workflow` | 用 steps/workflow_path 组合已注册验证器 |

这些是本框架的注册类型，不等同于 EvalScope 自带同名适配器。各类型参数见 `harmonyeval/verification/workflows/`；完整扩展示例见仓库 `docs/harmony-eval-framework-design.md` 第11节。

UITest/云测试内部可以编译、安装、运行、解析；不要为某个场景另造独立的 build 节点。`whiteboxeval` 当前是模型白盒评价，不自动等同于 integrations 中完整 ArkAnalyzer 工具链。

`SkillVerifier` 需要 `skill_path` 和 `model`，独立评价后的最终回答须为含 `metrics` 的 JSON；可带 dimensions/findings、可配置 result_schema。现有实现不会自动把任意 Markdown 报告转成分数。需要解析新报告格式时新增验证器，把解析后的指标交给评分器。

## YAML 的引用关系

以下是活动目标块里的片段，不是完整任务；外部验收脚本由场景提供：

```yaml
verification:
  - id: acceptance
    type: Command
    command: [python, /absolute/path/to/acceptance.py, --project, "${project}"]
    timeout: 600
scoring:
  - dimension: functionality
    type: BooleanScoring
    all:
      - source: acceptance.metrics.passed
        equals: true
```

`type` 映射注册类；`id` 是该次流程结果的键，必须唯一，并被 `depends_on`、评分 `source` 引用；`dimension` 是评分项的名称。修改 id 要同步引用，修改命令/标签不会改变规则类型。

`Command` 的非零退出码产生 completed + passed=false；若工具必须区分“断言失败”和“基础设施错误”，改用带结构化报告协议的验证器。不能把所有非零退出都解释成已完成业务测试。

## 验证器契约

```python
from harmonyeval.api import Workflow, VerificationResult

class ExampleAcceptance(Workflow):
    version = "1"
    schema = {"type": "object", "required": ["report_file"]}

    async def verify(self, case, execution, dependencies, context, config):
        # 实际执行与报告解析由场景实现；本段只展示结果契约。
        raise NotImplementedError("按实际验收协议实现")
```

新类放在独立包，不复制 evaluator 或改中央分发表。可以不继承，但要满足相同接口。可选 schema/validate 用于本类型的参数检查。

| 参数/辅助接口 | 使用约定 |
|---|---|
| `case` | 完整 EvalCase，验证阶段才可读取 expected 等私有资料 |
| `execution` | ExecutionResult；project 指目标工程，workspace 不一定与之相同 |
| `dependencies` | 按 depends_on 列出的前置流程 dict 结果 |
| `context["task"]` | 规范化任务；base_dir 是 task YAML 所在目录 |
| `context["output"]` | 持久证据目录 `verification/<id>/` |
| `context["env"]` / `cancel_event` | 工具环境与取消信号 |
| `requirements(config)` | 默认读 resources，提供同一进程内的资源互斥；不是跨进程设备租约 |
| `isolated_project(execution, context)` | 异步创建可修改的临时工程副本并登记清理 |
| `command_run(args, project, context, label, timeout)` | 异步运行参数数组，保留 stdout/stderr/退出码，处理超时和取消 |

辅助函数来自 `harmonyeval.verification.context`。command_run 只替换 `${project}`/`${output}`，不隐式执行 shell。自定义路径字段自行基于 task.base_dir 解析与校验。重验前清除将要读取的旧报告，防止把旧证据当作本次结果。

需要转换前基线时，实现 `async capture_input(self, case, config)` 返回 JSON 可序列化值。Agent 开始前框架保存到 `verification/<id>/input-evidence.json`，结构为 status/data 或 status/error；verify 应读取并校验此快照。不要在 Agent 结束后从已改工程重算“原始”API 基线。

返回 `VerificationResult(config["id"], status, metrics=..., evidence=..., version=self.version)`；证据应能支持指标复核，报告路径放 evidence，不能仅提供结论。

### 状态语义

- 测试确实执行且存在断言失败：可返回 `completed`，用 false、通过率和失败细项表示业务结果。
- 缺工具、无法运行、缺失/损坏报告、无有效断言：返回 `unavailable` 或抛异常由框架转换；保留错误与证据。已有适配器还可能返回 failed，接入前核对其语义。
- 前置流程非 completed，依赖流程会 skipped；completed 不保证业务指标通过，需要时自行检查 dependencies.metrics。
- 默认 requires_execution=true；Agent 执行失败时验证不可用。专门分析失败日志的流程可配置 false，并处理没有完整工程的情况。
- 零通过率需要实际执行结果支持；没有执行测试不能填零通过率。Agent 自报成功不是独立验收证据。

## 评分规则契约

内置：

| type | 配置与约定 |
|---|---|
| `BooleanScoring` | `all: [{source, equals}]` 全满足得 pass_score（默认100），否则 fail_score（默认0） |
| `ImmediateValue` | `source` 数值 × scale（默认1），结果在 [0,max_score]（默认100） |
| `WeightedSummation` | components 非空，weight 非负且总和1；base_score 默认100，按归一化指标比例扣分 |

例如已生成 `ui.metrics.pass_rate`（0～1）和 `code.dimensions`：

```yaml
scoring:
  - dimension: L2
    type: WeightedSummation
    mode: deduction
    base_score: 100
    components:
      - name: UX
        source: ui.metrics.pass_rate
        range: [0, 1]
        weight: 0.5
      - name: Whitebox
        source: code.dimensions
        reducer: proportional_deduction
        cap_source: code.metrics.total_score
        weight: 0.5
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
```

这对应当前一多口径：UITest 通过率代表 UX 占50%，白盒各维度按满分比例分配剩余50%并扣分，L3 直接读取白盒总分。它不是其他场景默认评分标准。白盒 dimensions 必须非空且每项 score/max_score 合法；cap_source 是同一量纲的总分上限。

内置无法表达时实现 `score(results, config) -> ScoreResult`：results 是验证结果 dict；使用 `harmonyeval.metrics.sources.source_value` 读取 `流程id.metrics.字段`。成功返回 status="scored"、score、max_score、breakdown 和 version。缺指标/来源不可用时抛 ValueError 等让 calculate_scores 产生 unavailable，或显式返回 unavailable + score=None；不要补0。该函数内不得调用模型、设备、编译或验收命令。

## 注册与安装

独立包的平铺布局：`pyproject.toml` 与 `example_eval/__init__.py` 同级；实现放 `example_eval/{datasets,verifiers,scorers}.py`。

```toml
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "example-eval-extension"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["harmonyeval>=0.3.0"]

[project.entry-points."harmonyeval.verification"]
ExampleAcceptance = "example_eval.verifiers:ExampleAcceptance"

[project.entry-points."harmonyeval.scoring"]
ExampleDeduction = "example_eval.scorers:ExampleDeduction"

[tool.setuptools.packages.find]
where = ["."]
include = ["example_eval*"]
```

按实现需要添加/删除 entry points，不要注册不存在的类。用例集同理使用 `harmonyeval.datasets`；新 target/engine 使用 `.targets`/`.execution`。新扩展优先用 `harmonyeval.*`，旧 `harmony_eval.*` 仍兼容。注册名必须唯一；entry point 类不要再用 @verifiers.register/@scorers.register，避免重复注册。

在运行框架的同一虚拟环境中 `python -m pip install -e /absolute/path/to/extension`，新进程中验证 `verifiers.get("ExampleAcceptance")` 可导入，再在 YAML 使用对应 type。复制文件或注册 OpenCode Plugin 都不能替代框架扩展的安装。

修改适配器行为、指标含义、验收脚本或 rubric 时更新相关 version/版本身份并重跑适当阶段；不保证任意外部命令文件的变化都被自动追踪。复用 verify/rescore，避免为重评估再调用生成 Agent。
