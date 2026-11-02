# HarmonyEval 架构与迁移说明

## 1. 源码、包名与入口

源码直接位于仓库根目录 `harmonyeval/`，Python 包名、分发名和主命令统一为 `harmonyeval`。已移除旧 src 目录、pyautorun 包映射、旧 JSON 批次调度和重复评分原型。版本为 0.3.0，要求 Python 3.10+，推荐 Python 3.12，EvalScope 固定兼容 1.14.x。

```sh
# 从旧版本升级，在当前 Python 环境先卸载旧分发，再安装新包。
python -m pip uninstall -y multi-device-autorun-python
python -m pip install -e '.[eval]'
harmonyeval run ./config/task.yaml --check
harmonyeval run ./config/task.yaml
# 等价的模块入口
python -m harmonyeval run ./config/task.yaml
```

## 2. 职责和 EvalScope 的对应

| 模块 | 职责 | EvalScope 对应 |
|---|---|---|
| api | 数据契约、结构接口、扩展注册表 | api，补充工程/设备评测所需的契约 |
| cli / config | 命令入口、YAML 校验、路径和活动块解析 | cli / config，保留本项目 YAML 语义 |
| benchmarks | 数据加载、公开输入与评价资料边界、样本转换 | benchmarks / api.benchmark / api.dataset |
| evaluator | 预检、调用 DefaultEvaluator、样本生命周期、指纹、复评 | evaluator / api.evaluator |
| agent | 目标来源、引擎、能力装载、执行环境、OpenCode SDK 和轨迹采集 | agent / agent.external / api.agent |
| verification | UITest、CloudTest、白盒、API 检查、工具观测及组合流程 | 项目业务扩展，由 DataAdapter.calculate_metrics 接入 |
| models | EvalScope 模型调用、密钥引用、ModelOutput 转换 | models / api.model |
| metrics | 指标取值、直接计分、布尔判定、比例扣分和聚合 | metrics / api.metric |
| experiments | MCP 分组覆盖、顺序执行、对比约束和刷新 | 应用层实验编排，每组调用 EvalScope 生命周期 |
| integrations | UITest Runner、AGC、源码 API 提取、完整白盒工具 | 外部系统与工具适配 |
| report | 主报告、实验报告、轨迹 HTML、历史格式报告维护 | report；业务证据展示保留自有扩展 |
| utils | JSON/JSON5、路径、哈希、Git、进程、复制与脱敏 | 公共基础设施 |

Evaluator 调度 Agent，Agent 执行本次任务；verification 将结果转成证据和指标，metrics 据此计分。UITest 不另起一套数据集 Evaluator；它是一个 verification workflow，内部调用 DevEco/设备 Runner，返回 VerificationResult。

### 2.1 benchmark 与 dataset 的注册层

EvalScope benchmark 是用例、输入组织、评价方法和指标聚合的完整评测基准；dataset 是其中的数据来源。本框架通过 HarmonyBenchmarkAdapter 注册一个公共 harmony_eval benchmark，在其内部按 YAML 选择 dataset、target/engine、verification 和 scoring。

各场景接入通常只需配置或新增这些业务适配器，无需分别注册 EvalScope benchmark。`harmonyeval.datasets/verification/scoring` 等 Python entry points 与 EvalScope 的 `register_benchmark` 是不同层次，不能互相替代。

当前 runner 固定选择 harmony_eval，YAML 没有任意 EvalScope benchmark 选择接口；修改 scenario 不会创建新 benchmark。详细契约与五个桥接方法见[重构指南的 EvalScope 接入说明](harmony-eval-framework-design.md#7-怎样接入-evalscope)。未来独立发布或选择其他 benchmark 时需另行设计接入，不能把它当作当前已实现能力。

## 3. 调用链和依赖边界

```text
CLI / YAML
  → experiments（若配置多组）
  → evaluator.runner
  → EvalScope DefaultEvaluator
  → benchmarks.evalscope.HarmonyBenchmarkAdapter
      ├─ run_inference
      │   → evaluator.sample：准备工程、冻结输入证据
      │   → agent.service：准备目标、运行引擎
      │   → 保存 patch、归档评价资料
      └─ calculate_metrics
          → verification.pipeline → 具体 workflow → integrations
          → metrics.scoring → SampleScore
  → metrics.aggregation → AggScore / EvalScope Report
  → report：JSON、HTML、实验对比
```

- api 不静态导入具体实现；api.builtins 只在需要时按模块名注册内置实现。
- utils 不依赖评测、模型或业务模块。
- agent 不依赖 evaluator、verification 或 benchmarks；样本流程衔接由 evaluator.sample 负责。
- models 不导入 Agent、设备和业务评价；agent.model 负责为 OpenCode/HTTP 引擎选择对应的模型访问桥接。
- metrics 不运行 Agent 或外部验证工具，只消费结构化验证结果。
- integrations 不依赖 evaluator、verification 或 benchmarks；输入由调用方转换为底层接口参数。
- 独立 SkillVerifier 使用公共裁判配置，不继承被测任务的 experiment 开关。
- 目录隔离保持现有行为，不宣称具备操作系统文件访问沙箱。

`tests/test_architecture.py` 检查显式绝对 import 的关键依赖方向、扩展兼容、包内资源及从仓库外启动模块入口；不完整覆盖相对/动态 import 和业务设计，不能通过换 import 写法绕过边界。

## 4. 关键迁移映射

| 旧位置 | 新位置 |
|---|---|
| src/harmony_eval/core.py | api/contracts.py、api/interfaces.py、api/registry.py、utils/ |
| src/harmony_eval/config.py、task.py | config/loader.py、config/__init__.py |
| src/harmony_eval/dataset_adapters.py | benchmarks/base.py、multidev.py、migration.py、text_qa.py |
| src/harmony_eval/evalscope_adapter.py | benchmarks/evalscope.py、evaluator/sample.py、agent/model.py、models/output.py |
| src/harmony_eval/runner.py | evaluator/runner.py、preflight.py、identity.py、replay.py、experiments/runner.py、report/io.py |
| src/harmony_eval/target_adapters.py | agent/targets/、capabilities/、environments/ |
| src/harmony_eval/execution.py | agent/service.py、engines/、environments/workspace.py、utils/processes.py |
| src/harmony_eval/verification.py | verification/pipeline.py、context.py、workflows/、api/interfaces.py |
| src/harmony_eval/score_rules.py | metrics/rules/、sources.py、scoring.py |
| src/harmony_eval/scoring.py | 删除未接入主流程的旧评分原型；现有规则集中到 metrics |
| src/harmony_eval/model.py | models/compatibility.py |
| src/harmony_eval/report.py | report/task.py、comparison.py、experiments.py、metrics/aggregation.py |
| src/harmony_eval/session_capture.py | agent/traces/session_capture.py |
| src/harmony_eval/api_inventory.py | integrations/code/api_inventory.py |
| src/devices | integrations/uitest；通用 JSON5 移到 utils/json5.py |
| src/cloud | integrations/agc |
| src/whitebox_eval | integrations/whitebox，含资源和可选 ArkAnalyzer 侧车 |
| src/runtime | agent/opencode 中的可复用 OpenCode SDK、运行时和交互能力 |
| src/reporting | report/trace.py、report/html.py、report/history/ |
| src/orchestration/artifacts.py、sandbox_copy.py | utils/git.py、utils/projects.py |
| src/orchestration/case_run.py 中的 now/write_json/safe_name | utils/formatting.py、utils/io.py |
| 旧 batch、case_run、batch_state、preflight、target_runtime 整批流程 | 删除，主任务仅走 EvalScope 调度 |
| src/tests | tests/integrations；共享产物测试保留，已移除旧调度专属测试 |

历史报告维护模块不参与新任务执行，不保留旧批次调度入口。完整白盒工具作为可选 integration 保留，其运行协议仍与当前 verification.whiteboxeval 的模型评价区分。

## 5. 兼容范围与扩展

- 现有 task YAML 的字段、注册 type、模型设置、用例目录、verification/scoring、实验开关、评分口径不因目录重构改变。
- 产物根目录继续由 report.output_dir 指定，保留现有 task-report.json、experiments-report.json、variants、verification 和 generate 结构。
- EvalScope 内部 benchmark 名 harmony_eval 保持，避免仅因源码改名更换缓存/报告标识。
- 新扩展入口组为 harmonyeval.datasets、targets、execution、verification、scoring、http_protocols；仍识别历史 harmony_eval.* 组名。Python 导入应更新为 harmonyeval，旧 pyautorun 导入不再提供。
- 公共接口从 harmonyeval.api 导入；工具函数从 harmonyeval.utils 对应模块导入；验证器复用 harmonyeval.verification.context 的 command_run、isolated_project。
- 修改验证器、评分器或执行适配器行为时继续更新其 version；本次迁移保持已有评分和验证语义。

扩展实现见 [扩展开发指南](harmony-eval-extension-guide.md)，完整 YAML 字段见 [字段参考](harmony-eval-config-reference.md)。

### 5.1 场景开发入口

场景开发者交付用例、被测对象配置、可复核的验证指标和评分口径，公共生命周期与报告继续由框架承担。完整分工、各场景接入内容、扩展选择顺序和最小交付物见[重构指南的验收与交付要求](harmony-eval-framework-design.md#8-怎样验收和交付)。

仓库 [AGENTS.md](../AGENTS.md) 引导开发 Agent 使用 [harmonyeval Skill](../.agents/skills/harmonyeval/SKILL.md)。该 Skill 随代码维护，是开发规范，不是加载进被测 OpenCode 的业务能力。配置能解决时不新增类，entry points 能扩展时不改主调度；公共接口调整同时同步 Skill、文档和受影响测试。

## 6. 自验证

```sh
python -m compileall -q harmonyeval tests
python -m unittest discover -s tests -q
HARMONY_EVAL_INTEGRATION=1 python -m unittest discover -s tests -p test_harmony_eval_opencode.py -q
npm run build:whitebox
```

覆盖模型代理、本地 HTTP、JSON 题集、MCP 分组、插件有无、输入资料边界、补丁归档、超时日志、评分/复评、扩展入口和包资源。真实设备、DevEco 编译和 AGC 验收仍需对应设备、SDK、认证与配额；本地模拟的成功不代替这些外部验收。

本次验证结果：113 项回归中 111 项通过、2 项默认跳过；另启用的 2 项真实 OpenCode/本地模型/MCP 集成全部通过。18 份 YAML 的解析值保持一致，7 份具体场景配置预检通过。独立 wheel 在仓库外安装并执行三个共享 JSON 问答用例，全部完成、评分 100；设备 CLI、包资源、ArkAnalyzer 编译和 wheel 内容边界检查通过。
