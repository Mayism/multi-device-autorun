# HarmonyEval 框架设计与重构指南

更新日期：2026-11-04。**本文用于指导另一个仓库的 Agent 完成重构。**那个仓库已有 static_eval 和一多适配评测，目录结构类似本仓库通用框架提交前的 develop。

目标是保住已有能力，把“主要围绕一多运行的工具”改成“由 task.yaml 选择用例、被测能力、验证方法和评分规则的通用评测框架”。后续接入三方库转换、Android 转鸿蒙、MCP 对照和 HTTP 问答时，应主要增加配置或适配器。

## 目录

- [1. 阅读方式与代码盘点](#1-怎么读以及先确认什么)
- [2. 重构目标](#2-重构完成后用户应该怎样使用)
- [3. 保留 static_eval 和原有能力](#3-已有能力怎样保留尤其是-static_eval)
- [4. 模块与接口](#4-代码应拆到哪里)
- [5. 分阶段实施](#5-按这八步实施每步都能验收)
- [6. YAML 与模块的关系](#6-yaml-怎么连接这些模块)
- [7. EvalScope 接入](#7-怎样接入-evalscope)
- [8. 验收与交付](#8-怎样验收和交付)
- [9. 实施 Agent 的任务说明](#9-可以直接交给实施-agent-的任务说明)
- [10. 实现细节](#10-实现时需要核对的细节)
- [11. 扩展验证器和评分器](#11-新增验证器和评分器)

## 1. 怎么读，以及先确认什么

docs 按用途维护以下文档：

| 文档 | 用来解决什么问题 |
|---|---|
| 本文：框架设计与重构指南 | 模块怎么分、旧能力怎么保留、按什么顺序改代码、怎样接 EvalScope、如何扩展和验收 |
| [YAML 配置说明与场景示例](harmony-eval-task-examples.md) | 怎样安装运行、字段有哪些值、怎样组织用例、怎样配置对照，以及18份完整任务配置 |
| [适配器设计与实现说明](harmony-eval-adapter-implementation.md) | 当前源码如何实现 EvalCase→Sample、验证调度和评分转换，以及三个适配器的完整扩展示例 |

**阅读顺序：**重构 Agent 先读本文第1～9节并按第5节实施；遇到细节再查[第10节](#10-实现时需要核对的细节)和[第11节](#11-新增验证器和评分器)。只配置任务时直接读 YAML 文档。开发约束同时遵循仓库 [AGENTS.md](../AGENTS.md) 和 [harmonyeval Skill](../.agents/skills/harmonyeval/SKILL.md)。

有两个仓库，要分清：

- **参考仓库**：当前 multi-device-autorun，已经有 harmonyeval 通用框架。源码、配置和测试供借鉴。
- **目标仓库**：你要改的另一份工程。本文没有查看它的代码，只知道它已有 static_eval 和一多评测；具体入口、字段和输出要由实施 Agent 先检查。

“类似旧 develop”是定位线索，不代表提交记录完全相同。参考仓库的 8af5f34 在通用框架之前，3795791 引入了通用框架；根目录 harmonyeval 分层属于后续重构，不能仅凭 3795791 推断已经具备。不要只按分支名判断代码状态，也不要为了对齐参考提交而回退目标仓库。

**首先产出一份目标仓库盘点表**：能力、当前入口、核心文件、配置来源、输出文件、可运行的最小用例、已有测试。至少覆盖 static_eval、一多 Agent 执行、设备测试、模型调用和报告。新建 harmonyeval 目录之前也能完成这个步骤。

## 2. 重构完成后，用户应该怎样使用

统一任务入口：

```sh
harmonyeval run ./config/task.yaml
```

一份配置回答六个问题：

| 配置 | 通俗解释 | 例子 |
|---|---|---|
| dataset | 拿什么来测 | 一批工程，或一份 JSON 问题集 |
| target | 测哪个对象 | HarmonyBot Agent、OpenCode Plugin/Skill、HTTP 后端 |
| execution | 怎样运行它 | 选 Agent、模型、超时和 SDK 环境 |
| verification | 怎样检查结果 | 跑 UITest、云测试、API 检查或独立模型评价 |
| scoring | 检查结果怎么算分 | 通过得100、通过率乘100、按权重扣分 |
| report | 报告放在哪里 | 指定输出目录 |

运行过程统一为：

```text
读取 task.yaml → 加载用例 → 执行被测对象
                            ↓
                       验证结果、保存证据 → 算分 → 汇总报告
```

例如一多和三方库转换：前者输入鸿蒙工程，后者输入待转换库；被测 Agent 不同、验证规则不同，但都走这条流程。不要为每个场景复制一份 CLI、批量循环和报告生成代码。

static_eval 仍按目标仓库已有语义运行。它是否针对能力配置执行一次，还是针对每个工程执行，不能从这个名字推断，见下一节。

## 3. 已有能力怎样保留，尤其是 static_eval

### 3.1 先分清“保留功能”和“移动文件”

| 已有部分 | 重构时的做法 |
|---|---|
| static_eval | 保留真实调用、输入、判据、结果和计分；先包一层接口，再整理位置 |
| 一多 Agent 会话 | 提取成单用例执行能力，保留提示词、模型设置和会话日志 |
| 设备/云测试 | 复用已有 Runner、构建、安装、轮询和报告解析，不凭空改写业务逻辑 |
| 原评分 | 保存一组固定输入的预期分数，迁移后对比；明确改口径时另行说明 |
| 旧入口与批量调度 | 迁移期间可保留作回归对照；新入口通后再移除重复调度和旧引用 |

**先验证功能等价，再删除旧文件。**最终业务任务统一使用 harmonyeval + YAML，但不要求在第一步就删除旧入口；static_eval 或设备工具仍在使用的公共模块不能顺手删掉。

### 3.2 static_eval 的迁移要求

参考仓库的 static_eval 目前仅保留配置，尚未执行。**目标仓库已经有这个能力，因此不能照抄参考仓库的“忽略此字段”逻辑。**示例中的 static_eval: {} 也不能覆盖目标的真实配置。

实施 Agent 先确认：它评什么、由谁触发、执行几次、是否改工程、结果怎么计分、失败时如何处理。然后选择连接方式：

| 目标仓库的实际行为 | 迁移方式 |
|---|---|
| 每个用例运行一次的工程静态检查 | 包装为 verification 工作流；检查放验证器，计算公式放评分器 |
| 对 Agent/Skill/Plugin 做一次静态评价 | 保留任务级调用和单独结果，公共编排放 evaluator，检查实现放 verification 或 integrations；不要把一次结果重复当成所有用例的独立评分 |
| 现有独立命令或服务 | 先保留可运行入口，用适配层连接现有输出，后续再逐步统一 |

当前通用框架的 verification pipeline 是逐用例的，没有已经实现的通用“任务级 static_eval”协议。若目标静态评价是任务级，需补对应编排和结果接入；不能仅把它塞进 verification 列表就声称等价。

第一阶段不改 static_eval 的业务口径，不假定它等同于 whiteboxeval，也不预先发明 enabled/scope 等新字段。已有字段、执行次数、失败语义和报告内容先保持兼容；需要统一结果格式时保留原始报告供核对。

完成标志：迁移前后同一固定输入走到了同一检查逻辑，执行次数一致；确定性分数相同。模型评价用固定裁判响应验证解析和计分，真实调用另验，不能要求两次自然生成文字完全相同。

## 4. 代码应拆到哪里

源码直接放在根目录 **harmonyeval/**。包名、安装名和命令都用 harmonyeval，不增加 src 这一层。

| 目录 | 只负责什么 | 旧结构中可能对应的代码 |
|---|---|---|
| api | 结果对象、接口、注册表 | 各文件重复定义的用例和结果结构 |
| config / cli | 读 YAML、校验、命令参数 | config、cli、preflight 的相应部分 |
| benchmarks | 读用例、准备公开输入、接 EvalScope 样本 | cases、dataset_adapters |
| evaluator | 串联整个流程、复评、缓存身份 | batch/case_run 中的编排部分 |
| agent | 执行 Agent/HTTP 任务、能力装载、会话日志 | runtime、agent、target_runtime |
| verification | 运行检查，产生指标和证据 | 设备验证、云测试、白盒/静态检查的接入层 |
| metrics | 根据指标算分、汇总有效分数 | L1/L2/L3 和其他计算公式 |
| models | EvalScope 模型访问与兼容层 | 模型客户端及代理接入 |
| integrations | SDK、设备、AGC、分析器等底层工具 | devices、cloud、静态分析工具实现 |
| experiments | 多组对照，只改变声明的条件 | 原有开关组别与对照编排 |
| report / utils | 展示结果；公共文件/进程/路径工具 | reporting、artifacts 等公共部分 |

这是按职责拆分，不是逐目录机械改名。目标仓库路径可能不同，由盘点结果决定搬哪些函数。static_eval 的具体文件在检查后加入映射表，本文不虚构一个已知旧路径。

三条核心边界：

1. Agent 负责完成任务，验证器负责检查，评分器负责计算。评分器不运行模型、设备或验收命令。
2. 底层设备/云端工具不反向导入整体调度器；公共 utils 不依赖业务实现。
3. 按注册的 type 找实现；新增场景不在主流程写 if scenario == ...。报告列从评分维度读取，不固定所有场景都叫 L1/L2/L3。

### 4.1 先统一四种结果

放在 api/contracts.py，使用可序列化的数据类或等价结构，字段与参考实现保持兼容：

| 结果 | 需要保留的字段 |
|---|---|
| EvalCase | case_id、question、root、project、expected、metadata；公开输入只含 case_id/question |
| ExecutionResult | status、answer、project、workspace、failure_category、error、elapsed_seconds、usage、artifacts、capabilities、tool_calls |
| VerificationResult | verifier_id、status、metrics、dimensions、findings、evidence、error、version |
| ScoreResult | dimension、status、score、max_score、breakdown、error、version；不可用时 score=None |

字段类型与默认值可对照参考源码 harmonyeval/api/contracts.py。静态评价的原报告允许附加保存；如果是任务级，单独记录作用范围和运行结果，不冒充某个用例的结果。

有效评分的 status 为 scored；不可评分为 unavailable 且 score=None。ExecutionResult 的 completed 只表示任务执行结束，是否做对要看验证指标，不能据此直接给满分。

### 4.2 适配器就是“接头”

相同接口可以接不同实现。配置只负责选择接头名称，主流程不用知道某个插件或测试服务的细节。

| 接口 | 关键方法 | Python 扩展注册组 |
|---|---|---|
| 用例集 | load(config)、prepare(case, workspace)、project_path(case, workspace)、fingerprint(case)、evidence_fingerprint(case)；可选 archive_evidence(case, output) | harmonyeval.datasets |
| 被测对象 | source(task)、prepare(task, runtime)，声明匹配的 engine | harmonyeval.targets |
| 执行引擎 | async execute(public_case, target, context) → ExecutionResult | harmonyeval.execution |
| 验证器 | async verify(case, execution, dependencies, context, config) → VerificationResult | harmonyeval.verification |
| 评分器 | score(results, config) → ScoreResult | harmonyeval.scoring |

验证器可选 requirements(config) 声明互斥资源，可选 async capture_input(case, config) 冻结修改前证据。context 包含 task、output、env、cancel_event、temporary_projects；dependencies 是按 depends_on 引用的前置结果。原工程检查与生成后检查要用正确快照。

先实现内置注册和参数校验，再支持独立包 entry points；同名重复注册报错。增加外部扩展不要求修改中央类型表。参考实现还提供 harmonyeval.http_protocols，以及历史 harmony_eval.* 入口组兼容，完整扩展示例见第11节。

## 5. 按这八步实施，每步都能验收

### 阶段 0：记录现状

- **做什么**：盘点现有入口和调用关系，记录当前配置、static_eval 原始结果、一多最小用例及测试命令。保存工作区已有修改，不覆盖它们。
- **交付**：迁移映射表、已有能力清单、可复现的基线结果；不能运行的外部环节写明原因。
- **验收**：能指出 static_eval 与一多分别由哪个入口实际执行，而不是只找到一个同名配置字段。

### 阶段 1：搭新骨架，先让配置读得懂

- **做什么**：创建根目录 harmonyeval 和安装入口，定义结果契约、注册表、YAML 解析；按 target.type 选择同名活动块，其他块不执行。
- **交付**：配置计划与校验能力，先不接真实模型或设备。
- **验收**：重复 id、未知 type、错误参数、依赖成环有明确错误；未启用块的占位值不影响本次任务。目标原有 static_eval 配置仍被保留，不能被空默认值抹掉。

### 阶段 2：保住 static_eval

- **做什么**：按第 3 节确认作用范围，给已有静态评价加薄适配层，迁移必要公共依赖；保持原判据和结果。
- **交付**：新结构中可到达的静态评价入口，以及迁移前后对照测试。
- **验收**：同一固定输入、相同执行次数、相同确定性指标；原命令/配置兼容方案明确。不要用 reference 的预留实现替换真实代码。

### 阶段 3：把一多拆成“执行”和“验证”

- **做什么**：提取只处理一个用例的 Agent 执行函数；已有 UITest/云测试包装成验证流程；保留模型、提示词、设备参数、日志和评分。
- **交付**：单用例能产生四种结构化结果；验证器在独立副本运行。
- **验收**：同一用例的提示词内容不变；Agent 修改完成后先固定 change.patch，再应用测试补丁或安装验证依赖；设备层结果可追溯。还没接 EvalScope 时可用离线函数测试，不新建另一套永久批量调度器。

### 阶段 4：让 EvalScope 承担正式生命周期

- **做什么**：按第 7 节接公共 benchmark、DefaultEvaluator 和模型代理；把阶段 3 的单用例执行交给它调用。
- **交付**：harmonyeval run 能从 YAML 完成用例加载、执行、验证、评分和报告。样本只展开一次，停止新入口继续转调旧 run_batch。
- **验收**：本地 HTTP 桩或本地模型能跑通真实 EvalScope 生命周期；OpenCode 的正式模型请求经过 EvalScope 模型兼容层，不能只在启动前发一次探针。所有测试结果注明是否为桩或真实设备。

### 阶段 5：接入其余场景

| 场景 | 应增加什么 | 先验收什么 |
|---|---|---|
| 三方库转换 | library-migration；选择 Skill/Plugin/Agent；API 数量和独立评价 | 源库副本、目标 base、转换前清单与转换后指标 |
| Android 转鸿蒙 | android-migration；选择真实 d2h Agent；业务验收流程 | 输入是原 Android 应用，目标工程位置正确，行为测试有实际判据 |
| MCP 对照 | 在同一任务上切换指定 MCP enabled | 其他条件相同，实际配置与调用证据可查 |
| HTTP 问答/客服 | text-qa；请求/响应映射；规则或 Judge | 公开请求不含标准答案，正确/错误/空答案/服务错误分别记录 |

- **交付**：各场景最小 YAML、最小用例、验证与评分口径。18 份参考配置可按需选用。
- **验收**：新增场景主要落在对应适配器或配置，主调度无需增加场景分支。真实 SDK、服务或用例暂缺时，适配链路与业务验收状态分别报告，不冒充已完成真实转换。

### 阶段 6：支持复评、重算和多组实验

- **做什么**：实现 without_enable 自动双组、verify、rescore、compare；分别记录输入、执行、验证和评分的摘要，用来判断旧结果能否复用。Skill/Plugin 对照无需声明 experiments；MCP 多组实验仍用 experiments，在临时运行副本覆盖 MCP 开关。两种对照不能同时启用。
- **交付**：旧工程可重新验证、旧指标可重新算分；各组结果独立，并有严格的配对比较。
- **验收**：verify/rescore 不再次调用生成 Agent；输入或能力变化拒绝错误复用；缺少转换前快照不能拿生成后代码补造。规则改动后旧差值不继续展示。

### 阶段 7：清理旧架构，检查安装和回归

- **做什么**：确认新入口覆盖已有能力后，删除重复批量调度、旧命名空间和无引用的兼容层，更新安装配置、包资源、命令和文档。
- **交付**：无 src 包映射的新结构、迁移记录、测试记录、剩余外部依赖清单。
- **验收**：从仓库外安装启动也能找到报告样式、设备脚本和静态评价资源；没有通过 sys.path 临时补丁掩盖打包问题；static_eval、一多旧能力的回归仍通过。

顺序允许按依赖小步调整，但不能跳过现有能力的回归，只提交“目录已经挪完”的结果。

## 6. YAML 怎么连接这些模块

下面只展示一条最简单的一多流程，路径与模型需替换后才能运行；完整 L1/L2/L3 配置和其他场景见示例册。

```yaml
schema_version: 2
id: multidev-example
scenario: MultiDev
dataset:
  type: swe-bench-hm-multi-dev
  dir: ./cases
target:
  type: harmonybot_agent
  dir: /path/to/harmonybot/source
harmonybot_agent:
  rounds: 1
  execution:
    engine: opencode
    agent_name: harmonyos-multi-device
    model:
      api_type: openai_api
      name: YOUR_MODEL
      base_url: https://example.com/v1
      api_key: MODEL_API_KEY
    enviroment:
      deveco_home: /path/to/DevEco-Studio
  verification:
    - id: ui
      type: UITest
  scoring:
    - dimension: test_pass_rate
      type: ImmediateValue
      source: ui.metrics.pass_rate
      scale: 100
  report:
    output_dir: ./output/multidev
    format: html
```

这里 target.type=harmonybot_agent，所以只读取 harmonybot_agent 块；ui 是这次验证的 ID，UITest 是实现类型，test_pass_rate 是报告列名。换列名不会换算法，改 ui 则要同步 source/depends_on。本片段未定义 static_eval，目标仓库的真实静态评价配置应按原字段迁移，不能据此删除。

容易误解的字段：

- **enviroment** 就保留这个拼写，表示 SDK/工具链路径；不再加 execution.runtime 或 runtime_config。
- **agent_name** 是实际注册的 Agent ID；Plugin 包名不必然等于 Agent ID。
- **knowledge/http_agent** 表示请求 HTTP 问答后端；MCP 定义放 OpenCode JSON，不放 knowledge 块。
- **without_enable** 表示是否启用目标 Skill/Plugin 的 without 对照：true 一次跑 without 和 with 并自动比较，false/省略只跑 with。无需额外的 experiments；Plugin 的 without Agent 默认 build，可用 without_agent_name 指定。对 MCP 开关用配置文件或 experiments；测 HarmonyBot Agent 本身不用自动生成“没有 Agent”的组。
- 迁移输入可用 case.yaml+source/，或 repositories 布局；文本输入用 JSON/JSONL。各工程用例的目标根是自己的 base/，不使用共享可写输出目录。

## 7. 怎样接入 EvalScope

benchmark 可以理解为“这套题如何出、如何检查、如何计分”的接入口，dataset 是题目本身。先共用一个 harmony_eval benchmark，由配置选择具体业务适配器。

参考实现使用 EvalScope 1.14.1，依赖范围 >=1.14.1,<1.15；建议 Python 3.12，主框架最低 Python 3.10。任务使用 custom 评测，调用 DefaultEvaluator，不为每种验证流程创建 EvalScope Evaluator。

| EvalScope 接口 | 实施时连接什么 |
|---|---|
| register_benchmark + BenchmarkMeta | 注册 HarmonyBenchmarkAdapter，继承 DefaultDataAdapter |
| load_dataset | 用例转 Sample，按 rounds 展开；EvalScope repeats=1，避免重复执行 |
| run_inference | 调用单用例执行函数，保存 ExecutionResult 到 TaskState 元数据 |
| calculate_metrics | 调用 verification 与 scoring，转换为 SampleScore |
| aggregate_scores | 仅聚合有效分数，保留覆盖率 |
| generate_report | 生成 EvalScope Report；项目报告补充工程与工具证据 |

runner 把解析后的 task 和 run_root 传入 benchmark 的 extra_params；Sample 元数据保留 case_index、case_id、round。run_inference 交接 case_output 和 execution，calculate_metrics 再定位该用例。工程和大日志保存为文件引用，标准答案不放进被测 Agent 的公开输入。

初版 TaskConfig.datasets 固定为 ['harmony_eval']。dataset.type 选择业务用例适配器，不是选择另一个 EvalScope benchmark。Python 包名 harmonyeval 与保留的 benchmark ID harmony_eval 不要混淆。

模型部分复用 EvalScope Model/ModelAPI 兼容访问；OpenCode 经模型代理访问配置的模型，独立裁判也走同一模型兼容层。能力装载、用例执行、验证、评分仍由各自模块负责，模型模块不读取业务目录来编排测试。桥接细节见第10节，扩展示例见第11节，不必重新造一套 EvalScope。

### 7.1 不同格式的用例怎样变成 EvalScope 输入

分两步转换：先让各数据集适配器读懂自己的格式，统一成 EvalCase；再由公共 HarmonyBenchmarkAdapter 转成 EvalScope 的 Sample。

```text
工程目录 / case.yaml / 原始仓库 / JSON、JSONL
  → dataset.type 对应适配器的 load(config)
  → list[EvalCase]
  → HarmonyBenchmarkAdapter.load_dataset()
  → Sample → MemoryDataset → default 子集 → DefaultEvaluator
```

| 原始输入 | 整理成 EvalCase 的方式 |
|---|---|
| 一多工程目录 | PROMPT.md 原文成为 question；base/task 路径成为 project；补丁路径放 expected，设备等原元数据放 metadata |
| 三方库 / Android 的 case.yaml | 读取 input.project 和 input.instruction；提示词追加统一 base/ 目录约定，验收资料放 expected |
| 原始仓库 repositories 布局 | 每个源工程形成一个用例；dataset.instruction 提供共享提示词，并追加目标目录约定 |
| 文本 JSON / JSONL | id、question 分别成为 case_id、question；reference_answer 统一为 expected.reference_answers 数组；project 为空 |

完整 EvalCase 保存在 benchmark 的 self.cases 中，转换成 Sample 时只取以下内容：

| EvalScope 字段 | 当前映射 |
|---|---|
| Sample.id | 按用例与轮次展开后的顺序编号，不直接使用 case_id |
| Sample.input | case.question，即公开任务要求或问题 |
| Sample.target | case.expected.reference_answers；没有文本标准答案时为 [] |
| Sample.metadata.case_index | 该用例在 self.cases 中的位置，用于找回完整 EvalCase |
| Sample.metadata.case_id | 原用例的稳定 ID |
| Sample.metadata.round | 当前轮次，从1开始 |

Sample.target 是评估参考答案，与 YAML 中表示“被测对象”的 target 不是同一个概念。工程源码、设备配置、测试和参考补丁不需要全部塞进 Sample；其他 expected/metadata 仍在 EvalCase 中，由验证阶段按需读取。

执行时，run_inference 根据 case_index 找回 EvalCase，再调用 prepare() 把公开工程复制到本用例的 base/，把 case.public() 的 case_id/question 和工作目录交给执行引擎。标准答案不随公开输入交给被测 Agent/HTTP 后端。验证时使用完整用例、执行结果与证据来评分。

对应源码是 benchmarks/multidev.py、migration.py、text_qa.py 和公共桥接 benchmarks/evalscope.py。新增格式只要能表达为 EvalCase，通常实现新的用例集适配器即可，公共 Sample 转换和 EvalScope 调度继续复用；不是每种格式都要注册一个新的 benchmark。

## 8. 怎样验收和交付

### 8.1 先验证状态不会误报

| 实际情况 | 应如何记录 |
|---|---|
| 工具跑完，断言全通过 | completed，指标通过，按规则给分 |
| 工具确实跑完，但断言失败 | 可 completed + passed=false/低通过率，产生有效低分 |
| 模型、设备、工具或报告不可用 | unavailable/对应执行错误，评分不可用；不能直接补0或100 |
| 前置流程未完成 | 依赖流程 skipped，保留原因；completed 不等于业务指标通过 |

报告展示总样本数、完成数、已评分数、有效均分和覆盖率。两组只对双方都有有效分数的同一 case_id+round 求差值，同时报告配对覆盖；不让失败样本消失后形成虚高结论。

### 8.2 一多评分保留已确认口径

- L1：构建与功能是否全部通过。
- L2：UITest 通过率代表 UX，占50%；白盒各维度按满分比例分配另外50%并扣分，保留白盒总分封顶。
- L3：直接读取白盒总分。

例如 UITest 通过率80%、白盒各维度合计80/100且无额外封顶，L2 为80。公式放 metrics，数据来源写进 YAML，别在调度器中按 L2 这个名字猜算法。目标仓库 static_eval 的分数是否参与其中，先按原口径核对；不能未经说明重复扣分或混入白盒总分。

### 8.3 证据和复用规则

Agent 工作工程保留 base/；会话轨迹保留 generate/agent-output.json/html、events.jsonl、stderr.jsonl；验证证据保存 verification/<id>/。change.patch 在验证改动前固定，metadata/test/golden 补丁在 Agent 停止后归档。可清理的配置、数据库和验证副本放系统临时目录，结束清理。

目标 static_eval 原来需要的输入、原始报告和资源在盘点后加入保留清单；上面的参考目录不是删除其他有效产物的理由。目录隔离和补丁后复制不等于操作系统文件访问沙箱。

修改评分规则用 rescore，修改验证用 verify，修改输入、模型或被测能力重新 run。适配器行为变化更新 version；外部命令脚本不一定被自动哈希，应把其版本纳入身份，不只改包版本号。

### 8.4 最少做哪些检查

| 检查层 | 必须得到什么证据 |
|---|---|
| 配置 | YAML 可加载，类型/引用/依赖正确；所有场景样例均做语法检查 |
| 原有能力 | static_eval 固定输入回归、一多单用例回归，原业务判据仍生效 |
| 正常与异常 | 业务成功、业务失败、缺证据、坏报告；相关超时/取消能保留日志 |
| 真实链路 | 至少跑通本地 HTTP 或本地模型到 EvalScope 的完整路径；有环境时验真实 Agent/设备 |
| 扩展 | 同一 Python 环境安装扩展，新进程可以发现；无需修改 CLI 和报告调度 |
| 打包与架构 | 仓库外能启动，资源齐全；检查依赖方向，不用动态 import 绕过约束 |
| Windows 兼容 | 文件显式 UTF-8，工具输出按协议解码；覆盖中文/空格路径与 GBK 不能表示的字符，注明是真实 Windows 还是本机编码模拟 |

--check 只检查准备项，不证明密钥授权、MCP 工具实际使用、设备/云端测试成功。参考仓库的113项等历史测试数量也不是目标仓库必须“凑齐”的验收标准，按目标实际能力完成有效回归。

新骨架和对应命令完成后，可用下面的命令核对。安装命令要求目标 pyproject.toml 已提供 eval 可选依赖；task.yaml 替换为当前阶段准备好的最小任务。旧能力的回归命令使用阶段0记录的实际入口，不凭空假设目标已有同名测试文件。

```sh
python -m pip install -e '.[eval]'
python -m harmonyeval plan ./config/task.yaml
python -m harmonyeval run ./config/task.yaml --check
python -m unittest discover -s tests -q
```

```sh
harmonyeval verify ./config/task.yaml --run /path/to/single-run
harmonyeval rescore ./config/task.yaml --run /path/to/single-run
harmonyeval compare /path/to/without-run /path/to/with-run --output ./output/comparison
```

--run 指单组运行目录。配置 experiments 时应选择其中一个实验组的目录，不能直接把整个多组批次当成单组结果。

每阶段交付改动文件、迁移前后对应关系、运行过的命令及结果、未完成项。不要只写“已经支持”，要说明通过的是离线桩、真实模型、真机还是云服务。

## 9. 可以直接交给实施 Agent 的任务说明

```text
请按《HarmonyEval 框架设计与重构指南》修改当前目标仓库。

目标仓库已有 static_eval 和一多适配评测，结构类似旧 develop；不要假定它已经包含参考仓库的新框架。
先阅读当前代码，列出入口、配置、输出、测试以及旧模块到新目录的迁移映射。
特别确认 static_eval 实际评测对象、调用时机、执行次数、判据和评分；保留真实实现，不能照抄参考仓库的预留行为。

按主指南第5节分阶段实施：骨架与契约 → 保留静态评价 → 提取一多单用例执行与验证 → 接 EvalScope → 扩展其他场景 → 复评/对照 → 清理旧结构。
统一主入口为 harmonyeval run task.yaml，源码放根目录 harmonyeval。
新增场景通过用例集、执行、验证、评分适配器连接，不复制主调度器或为 scenario 添加专用分支。
完整字段、用例格式和18份配置都查《YAML 配置说明与场景示例》；桥接与扩展查本文第7、10、11节，本机路径和密钥不要照抄。

边检查边实施，每阶段做相应自验证；业务口径无法从代码确定时再提出具体问题。
结束时列出已改内容、保留的 static_eval/一多能力、实际验证命令和结果、尚需外部环境才能验证的项目。
```

移交时提供本文和《YAML 配置说明与场景示例》即可获得完整设计、字段与配置；需要自动遵循开发约束时，再附上仓库的 AGENTS.md 和完整 Skill 目录。参考源码可访问时给出路径或版本；不可访问时，Agent 按这里的接口和验收要求在目标仓库实现，缺业务资料明确说明。

## 10. 实现时需要核对的细节

本节供实施时查阅。参考源码路径均相对根目录 harmonyeval/；目标仓库的已有 static_eval 仍按第3节保留，不能因参考源码缺少对应实现就关闭它。

### 10.1 单用例的调用顺序

```text
CLI / YAML → experiments（需要对照时）→ evaluator.runner
  → EvalScope DefaultEvaluator → benchmarks.evalscope.HarmonyBenchmarkAdapter
      run_inference:
        准备用例副本 → 冻结输入证据 → 运行 Agent/HTTP
        → 固定 change.patch → 归档评估资料 → 保存 ExecutionResult
      calculate_metrics:
        verification.pipeline → 各验证器 → metrics.scoring → SampleScore
  → metrics.aggregation → EvalScope Report → 项目 JSON/HTML/对比报告
```

多轮只在 case × rounds 中展开一次，EvalScope repeats=1。without_enable=true 先展开两个隔离子组；MCP experiments 按声明展开。分组复用同一条样本流程，不再回调旧整批调度。

### 10.2 用例、评估资料与补丁

用例集适配器负责 load、prepare、project_path、公开输入指纹和评估资料指纹。优先继承 benchmarks/base.py 的 DatasetAdapter；新增私有字段时检查复制过滤、指纹和归档，不能只把路径塞进 metadata 就认为已经隔离。

- Agent 只获得公开问题和输入工程；标准答案、test/golden patch 和评分参考留在评估侧。
- Agent 停止后先固定 change.patch，再在验证副本中应用测试补丁、安装依赖和运行工具；安装后的锁文件改动不混入 Agent 修改。
- 一多的 archive_evidence 归档原 metadata 和声明的补丁，超时或错误也保留；verify 可以补归档。验证副本清理不能删掉持久证据。
- 有 target_template 时，base/ 放目标模板，同级 input/ 放原工程；普通工程用例各有自己的 base/。Web 组合工程由适配器定位实际容器工程。
- 准备副本不是操作系统文件访问沙箱，不能据此承诺 Agent 无法跨目录读取源用例。

### 10.3 OpenCode、模型与会话

target 负责定位独立 OpenCode 或 HarmonyBot bundle，再准备私有配置、能力副本和运行数据库。默认配置、显式 config_path 和任务选择按约定合并；相对引用按声明它的文件解析。只切换目标 Skill/Plugin/MCP，保留公共能力，不修改用户全局安装。

Plugin 从 target.dir 的 package.json.main 解析入口，可用 entry/options 覆盖；Skill 按 frontmatter 名称选择。Agent ID 从实际注册表核验，不能根据插件包名猜测。without 组实际状态看 target_enabled 与能力清单，不看 without_enable 这个请求开关来推断。

OpenCode 的主/小模型和子 Agent 请求统一经过 EvalScope 模型代理；裁判也走模型兼容层。密钥可使用环境变量，规范化后避免把明文写进配置快照和报告。启动前探测接口成功不代表正式调用链已经接入。

会话数据库只导出本次私有数据库的主会话和 parent_id 关联的后代；session_capture 标注导出模式，失败时退回 CLI 事件。插件自行启动的无父子关联根会话不会自动收集。idle_timeout 只看主 CLI stdout 静默，不能据此判断所有子 Agent 无活动；总超时和取消须清理进程树，并保留已有回答、错误、用量和代理轨迹。

### 10.4 验证与评分的证据要求

verification.pipeline 按 depends_on 调度；前置状态 completed 才继续，但这不保证前置业务指标通过。工作流可用 requires_execution=false 分析失败执行，必须自行处理缺工程和部分产物。

context.output 是 verification/<id>/ 的持久目录。isolated_project 创建并登记临时工程副本；command_run 处理参数数组、超时、取消、stdout/stderr 和进程树清理，只替换 ${project}/${output}，不隐式运行 shell。资源锁只在同一进程生效，多个独立评测命令仍需额外协调设备。

UITest/CloudTest 内部组织编译、安装、执行和解析，不另拆 build 验证节点。云端类别映射、认证和签名要用真实协议；不能看到类型名就假设某个服务已经可用。

whiteboxeval 当前是独立模型评价，不等于完整 ArkAnalyzer。默认维度为功能正确性40、要求覆盖30、代码质量20、兼容性10，显式 rubric 优先。空回复、坏 JSON、缺维度或超出 max_evidence_chars（默认100000）记为 unavailable，并保留 judge.json；不能截断后声称评过完整工程。

LibraryAPICount 在生成前 capture_input，之后分别比较公开类型、方法/函数、属性/常量：

```text
count_consistency = Σ min(原库分类数量, 目标分类数量)
                    / Σ max(原库分类数量, 目标分类数量)
得分 = 100 × count_consistency
```

count_match 要求三类分别相等，total_match 只看合计。语法树提取支持 Dart、TS/ETS兼容语法、ES模块JS、Java、Kotlin；重载、getter/setter等有合并规则，不展开继承或外部 re-export，CommonJS/ETS专有语法等仍有限制。解析失败或原库无公开 API 时不可用；数量一致不证明语义或功能兼容。

### 10.5 产物与复评边界

```text
report.output_dir/<run_id>/
  task.resolved.yaml          # 脱敏任务快照；最终能力清单在样本 execution.capabilities
  task-report.json            # 统一汇总数据、指纹、执行/评估/评分记录
  index.html                 # 由 task-report 数据生成
  evalscope/                 # EvalScope 原生预测、评估缓存及报告
  variants/<with|without>/round-01/cases/<case_id>/
    base/                    # Agent 工作目录及生成工程
    metadata.json            # 一多：执行结束后归档的原始用例元数据
    test_patch.patch         # 一多：实际文件名/子目录以 metadata.test_patch 为准
    golden_patch.patch       # 一多：实际文件名/子目录以 metadata.golden_patch 为准
    input/                   # 仅配置 input.target_template 时保存原工程副本
    change.patch             # Agent 修改完成后、评估流程改动前生成
    generate/
      agent-output.json      # 回答、状态、会话、session_capture、model_trace
      agent-output.html      # 会话浏览器；耗时按时分秒、token 使用 k 格式
      events.jsonl           # OpenCode CLI 原始事件
      stderr.jsonl           # 进程错误输出
    verification/<id>/
      input-evidence.json    # capture_input 可选生成；如转换前 API 清单
      api-count.json         # LibraryAPICount 结果
      api-count.md           # LibraryAPICount 可读明细
      judge.json             # 白盒/Judge 结构化结果，解析失败时保留原文
      ...                    # 各流程的必要测试与工具证据
```

without_enable 或 MCP 多组任务的每个子组都保留上述单组结构，外层另有 experiments-report.json 与 comparisons/。HTTP 文本任务没有工程时不要求伪造 base 工程。

每次 run 创建新目录；没有跨批次自动命中或失败重试功能。复用身份包括公开输入、目标/模型/预算、能力源文件、适配器 version 和已支持的评估文件；任意外部脚本不一定被自动哈希。改工具脚本或判据要维护版本，不能只升级 Python 包版本。

verify 需要原数据集和必要工程/证据仍在；缺转换前 input-evidence.json 不能用生成后源码补造。rescore 只用已有指标。对照严格配对 case_id+round，核验两组公共配置、实际装载状态、验证与评分身份；缺证据不计零分。重新评分期间两组规则不一致时，比较暂为不可用，并清掉旧差值。

新 MCP 对照只忽略 experiments 声明服务器的 enabled。未使用 experiments 的历史 KnowledgeEval 比较规则较宽，需人工确认只切换了目标 MCP。模型接口失败、设备失败和有效业务低分分开记录；写出 HTML 不是成功标志。

### 10.6 依赖方向与安装资源

| 模块 | 不应依赖 |
|---|---|
| api | Agent、评测调度、验证、模型、计分、底层工具和报告的具体实现 |
| utils | 业务层、配置、模型和调度 |
| models | Agent、设备、验证、用例集和业务报告 |
| metrics | Agent、验证执行、用例集、设备工具和报告生成 |
| agent | evaluator、verification、benchmarks |
| integrations | evaluator、verification、benchmarks |

tests/test_architecture.py 检查显式绝对 import 的关键方向、扩展兼容、包资源和仓库外启动；它不覆盖所有相对/动态依赖或业务设计，不能靠换 import 写法绕过边界。公共契约放 api，用注册接口连接实现。

安装时同步 console script、包发现和 package-data；报告 CSS、设备 ETS/Python 脚本、白盒规则和提示词等资源要能从 wheel 读取。可选 ArkAnalyzer 按项目 npm 构建；完整白盒工具与当前模型验证器是不同入口。目标 static_eval 的资源也要按实测加入打包和回归清单。

#### 10.6.1 Windows 与编码是全工程要求

所有修改都考虑 Windows，而不只修改设备适配器时才考虑。文本文件读写显式指定 UTF-8，不依赖系统 GBK/CP936 默认编码；外部工具输出按其实际协议解码，不能因设置 text=True 就认定是 UTF-8。可能输出 GBK/GB18030 的工具应有明确策略，必要时保留原始字节；损坏的结构化结果不能按成功解析。

控制台及重定向输出应处理 GBK 无法表示的字符，避免 Emoji、特殊符号引发 UnicodeEncodeError 而中断评测。日志可安全转义；验收数据不能用 errors="ignore" 静默丢弃。Python 的 UTF-8 环境变量只能影响相应 Python 进程，不能代替文件编码或所有外部工具的协议。

同时检查中文/空格路径、盘符、命令入口、文件占用和进程清理，复用公共跨平台工具。相关逻辑变更补充编码与路径测试；交付注明是否在真实 Windows 上运行，本机编码模拟不等于 Windows 实测。仓库内的详细规则见 [AGENTS.md](../AGENTS.md)。

公共编码处理放在 `harmonyeval/utils/encoding.py`，各场景复用，具体行为如下：

| 边界 | 处理方式 |
|---|---|
| Agent 日志、配置、提示词、报告 | 显式 UTF-8；OpenCode 输出重定向文件使用二进制捕获，再按 UTF-8 读取 |
| 控制台与重定向日志 | 保留终端编码；无法表示的字符安全转义，避免错误提示再次抛出编码异常 |
| CLI 的 JSON 输出 | 非 UTF-8 终端使用 JSON 自身的 ASCII 转义，确保 Emoji 等内容可以完整解析恢复 |
| 框架启动的 Python 子进程 | 执行环境设置 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`，包括 Agent 工具继承的环境 |
| Windows Plugin CLI 入口 | `.cmd` 内容保持 ASCII，通过 Node 桥接传递 Unicode 路径与参数，避免批处理文件被按 GBK 解释错 |
| OpenCode JSON 事件、框架 Python 协议 | 按 UTF-8 严格解码；OpenCode 事件出现非法字节时保留 `events.invalid.bin`，执行标记为基础设施错误 |
| 原生构建与 Git 诊断 | 先捕获字节，可读日志按 UTF-8、GB18030 顺序尝试；无法解码的字节用十六进制转义。构建出现非 UTF-8 输出时保留相邻 `.raw` 文件，Git 补丁诊断在命令日志中保留 Base64 原始字节 |

这些措施不能约束 Agent 自行显式选择 GBK 的脚本，也不能改变 Node、Java、设备工具自身的输出协议。新增协议仍需声明其编码，不能用诊断日志的编码回退来解析结构化验收结果。`tests/test_windows_encoding.py` 覆盖 GBK 默认文件读写、控制台、真实 Python 子进程，以及通过本地 HTTP 服务运行完整 EvalScope 流程；这是本机模拟，不代表真实 Windows 实测。

### 10.7 参考仓库的旧路径对照

以下是参考仓库的迁移记录，用来帮助定位类似旧 develop 的代码。目标仓库不同的文件按职责映射，不能据此删除仍被 static_eval 使用的公共代码。新位置均位于 harmonyeval/ 下。

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

## 11. 新增验证器和评分器

以下以三方库验收为例，提供独立 Python 扩展包的完整接口、证据协议和注册方式；业务判据仍由场景提供。已有 Command、Workflow、SkillVerifier 或内置评分规则够用时，直接配置，不必新增类。

### 11.1 先选择需要扩展的层

| 需求 | 做法 | 是否新增 Python 类 |
|---|---|---|
| 已有命令的退出码即可判断通过 | verification 使用内置 Command，评分用 BooleanScoring | 否 |
| 重组现有验证流程 | verification 使用 Workflow 的 steps/workflow_path | 否 |
| 已有指标只需取值、按比例换算或加权 | 使用 ImmediateValue、BooleanScoring、WeightedSummation | 否 |
| 执行新的验收工具、解析新格式、产生新指标 | 新增验证器 | 是 |
| 分段扣分、关键功能额外扣分等内置规则无法表达 | 新增评分器 | 是 |

验证器负责产生可复核事实，如总验收项数、通过项数、关键失败数及证据。评分器读取这些结果做确定性计算；不要在评分器里再次编译、请求模型或运行测试。一个验证器可以对应多个评分维度，多个验证器也可共同供一个评分器使用。

### 11.2 自行创建扩展包并注册

需要扩展时，自行在任意目录创建以下项目；本文只提供指南，不附带安装包或模板代码目录：

```text
my-library-eval/
  pyproject.toml
  harmonyeval_library_demo/
    __init__.py
    counts.py
    verifiers.py             # LibraryAcceptance
    scorers.py               # AcceptanceDeduction
```

下文代码用于说明验收工具适配和评分接口，**不包含真实三方库的功能判据或验收程序**。开发时还需提供实际验收脚本，使其完成必要的构建/接口/行为检查，按第11.4节协议输出证据。

自行创建扩展包的 pyproject.toml，注册名称指向下文的 Python 类：

```toml
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "my-library-eval"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["harmonyeval>=0.3.0"]

[project.entry-points."harmonyeval.verification"]
ExampleLibraryAcceptance = "harmonyeval_library_demo.verifiers:LibraryAcceptance"

[project.entry-points."harmonyeval.scoring"]
ExampleAcceptanceDeduction = "harmonyeval_library_demo.scorers:AcceptanceDeduction"

[tool.setuptools.packages.find]
where = ["."]
include = ["harmonyeval_library_demo*"]
```

左侧名称就是任务 YAML 的 type，右侧指向可导入的类。命名应避免与内置类和其他扩展重复。独立包中的类**不要再添加 @verifiers.register/@scorers.register 装饰器**，框架加载 entry point 时已经注册，再注册会报重名。

安装到运行 harmonyeval 的同一个 Python 环境：

```sh
source .venv/bin/activate
# 先按本文完成自己的扩展包，再替换为它的实际目录。
python -m pip install --no-deps -e /absolute/path/to/my-library-eval

# 使用新 Python 进程检查两个类型是否能被发现，无需模型和设备。
python -c "from harmonyeval.api import verifiers, scorers; print(verifiers.get('ExampleLibraryAcceptance')); print(scorers.get('ExampleAcceptanceDeduction'))"
```

这个环境应已安装主框架及 `.[eval]` 依赖；其他机器可使用自己建立的虚拟环境。仅复制 Python 文件到磁盘不会自动注册；安装后启动新的 harmonyeval 命令，entry points 会被自动发现。扩展可以维护在独立仓库并固定包版本，无需放入主框架仓库。

### 11.3 验证器接口

自行实现 verifiers.py，例如：

```python
"""Adapt a user-provided acceptance tool to Harmony Eval's workflow contract."""
import json

from harmonyeval.api.contracts import VerificationResult
from harmonyeval.utils.paths import inside
from harmonyeval.verification.base import Workflow
from harmonyeval.verification.context import command_run, isolated_project

from .counts import acceptance_counts


class LibraryAcceptance(Workflow):
    version = '1'
    schema = {
        'type': 'object', 'required': ['command'],
        'properties': {
            'command': {'type': 'array', 'minItems': 1, 'items': {'type': 'string'}},
            'report_file': {'type': 'string', 'minLength': 1},
            'timeout': {'type': 'integer', 'minimum': 1},
        },
    }

    async def verify(self, case, execution, dependencies, context, config):
        # Build/install/test inside this copy; do not mutate the agent's base/.
        project = await isolated_project(execution, context)
        report = inside(context['output'], config.get('report_file', 'acceptance.json'))
        # Re-verify must not accept an old report left by a previous invocation.
        report.unlink(missing_ok=True)
        outcome = await command_run(config['command'], project, context,
                                    'acceptance', config.get('timeout', 600))
        evidence = [outcome]
        if not report.is_file():
            return VerificationResult(config['id'], 'unavailable', version=self.version,
                                      error='验收工具未生成报告', evidence=evidence)
        evidence.append(str(report))
        if outcome['exit_code'] not in (0, 1):
            return VerificationResult(config['id'], 'unavailable', version=self.version,
                                      error='验收工具基础设施错误', evidence=evidence)
        counts = acceptance_counts(json.loads(report.read_text(encoding='utf-8')))
        all_passed = counts['passed'] == counts['total']
        if (outcome['exit_code'] == 0) != all_passed:
            raise ValueError('验收工具退出码与报告的通过状态不一致')
        return VerificationResult(
            config['id'], 'completed', version=self.version,
            metrics={**counts, 'passed_all': all_passed,
                     'pass_rate': counts['passed'] / counts['total']},
            evidence=evidence,
        )
```

上例读取验收工具实际生成的报告，并检查退出码和计数是否一致。acceptance_counts 的实现示例见第11.4节；这些类需要自行创建并安装后才能在 YAML 中引用。

| 参数/方法 | 实际含义 |
|---|---|
| case | EvalCase，包含 case_id、question、root、project、expected、metadata；可在评估阶段读取验收专用资料 |
| execution.project | Agent 生成的目标工程；普通迁移任务是本用例 base/ |
| execution.workspace | Agent 的工作目录；Web 组合工程可能与 project 不同 |
| dependencies | depends_on 声明的前置流程结果字典，内容已转为 dict |
| context.output | 此流程的持久证据目录，即 verification/本流程id/ |
| context.env | 已合并工具链的进程环境 |
| context.temporary_projects | 登记需在流程结束清理的临时工程；isolated_project 会自动登记 |
| config | 本 verification 条目的规范化配置 |
| requirements(config) | 返回资源名称列表；继承 Workflow 默认读取 resources，用于同一进程内互斥 |

尽量复用 isolated_project 和 command_run：前者保护 Agent 原产物，后者处理进程取消、超时、进程树清理，并保存命令 stdout/stderr。外部命令是参数数组，只支持 `${project}` 和 `${output}` 替换，不是 shell 脚本字符串；需要 shell 特性时显式运行自己的脚本。

框架只自动规范化已支持的路径字段。command 中的验收脚本建议填绝对路径，不能假定其 cwd 是仓库根目录。新增自定义路径参数时，在验证器内基于 context.task.base_dir 解析并校验；不要指望任意字段自动转换成绝对路径。

#### 结果状态的约定

- 流程正常结束，即使部分断言失败，也可返回 completed，并用 metrics.passed_all=false、pass_rate 等表达业务结果；下游可以读取指标并给低分。
- 工具缺失、无法启动、报告未生成、JSON 不合法或没有执行任何验收项，返回 unavailable 或抛出异常让框架转换为 unavailable，不能伪造零通过或满分。
- depends_on 只在前置状态为 completed 时继续，不代表前置业务指标全部通过；需要时自行检查 dependencies 中的 metrics。
- 默认 requires_execution=true，Agent 未完成则不运行。专门分析失败过程的验证器可显式设置 false，并自行处理无工程/部分产物。

#### 需要转换前快照时

可选实现 `async capture_input(self, case, config)`，返回可 JSON 序列化的数据。框架在 Agent 执行前保存为该流程目录的 input-evidence.json，verify 再读取原快照。不要在 verify 中用已修改的工程冒充转换前基线，也不要把样本状态保存在共享类实例中。旧任务没有该快照时，应提示重新运行生成阶段。

### 11.4 设计验收报告协议

用户提供的验收工具应把报告写入 `${output}/acceptance.json`：

```json
{
  "total": 10,
  "passed": 8,
  "critical_failures": 1
}
```

这些数字必须来自实际检查，不是 Agent 自报；本例要求非负整数、total>0、passed<=total，关键失败数不超过失败总数。工具退出码约定为：0=全部通过，1=已执行但存在验收失败，其他退出码=工具或基础设施错误。退出码与报告不一致也视作不可用。

构建、安装和测试由这个验收工具组织，仍是一项完整 verification 流程，无需在任务 YAML 另拆 build 节点。每个断言的详细结果、日志、JUnit 或 API 对照表可另存到 `${output}`；需要体现在统一报告时，将路径追加到 VerificationResult.evidence。

计数校验可在自己的 counts.py 中实现，供验证器和评分器共用：

```python
"""Validate a small acceptance-tool protocol; missing evidence is never a zero."""


def acceptance_counts(raw):
    counts = {}
    for key in ('total', 'passed', 'critical_failures'):
        value = raw[key]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f'{key} 必须是非负整数')
        counts[key] = value
    if counts['total'] == 0:
        raise ValueError('没有执行验收项，不能形成有效评分')
    if counts['passed'] > counts['total']:
        raise ValueError('passed 不能超过 total')
    if counts['critical_failures'] > counts['total'] - counts['passed']:
        raise ValueError('critical_failures 不能超过失败项数')
    return counts
```

### 11.5 在当前三方库 YAML 中启用

保留原有 dataset、target、execution，以及 API 数量和白盒流程。在**生效的 plugin_agent 块**中追加：

```yaml
plugin_agent:
  verification:
    # 原有 api、code 条目保留，在下面追加这个条目。
    - id: library_acceptance
      type: ExampleLibraryAcceptance
      timeout: 900
      report_file: acceptance.json
      command:
        - python
        - /absolute/path/to/verify_library.py
        - --project
        - ${project}
        - --report
        - ${output}/acceptance.json
  scoring:
    # 原有 api_count_consistency、L3 保留，追加一个新维度。
    - dimension: library_acceptance
      type: ExampleAcceptanceDeduction
      source: library_acceptance.metrics
      critical_penalty: 20
```

这段是追加片段，不是完整任务；不要在原文件中再建一个同名 plugin_agent 顶层键。`/absolute/path/to/verify_library.py` 是你自己的实际验收程序；本文不实现具体库的业务判据。多个库的验收规则不同时，可通过 case.expected/metadata 读取各自规则，在自定义 verify 中组织命令。

不需要自定义扣分规则时，上述 verification 可以直接配内置评分器：

```yaml
- dimension: library_acceptance
  type: ImmediateValue
  source: library_acceptance.metrics.pass_rate
  scale: 100
```

二者是同一维度的替代方案，不要同时配置同名 dimension。id 是验证流程标识，source 的第一段必须引用已配置的 id，dimension 是最终报告中的评分列名；两者可不同。

### 11.6 自定义评分器接口

```python
"""An example deterministic deduction rule over acceptance metrics."""
from harmonyeval.api.contracts import ScoreResult
from harmonyeval.utils.numbers import number
from harmonyeval.metrics.sources import source_value

from .counts import acceptance_counts


class AcceptanceDeduction:
    version = '1'
    schema = {
        'type': 'object', 'required': ['source'],
        'properties': {'source': {'type': 'string'},
                       'critical_penalty': {'type': 'number', 'minimum': 0}},
    }

    def score(self, results, config):
        counts = acceptance_counts(source_value(results, config['source']))
        penalty = number(config.get('critical_penalty', 20))
        if penalty < 0:
            raise ValueError('critical_penalty 不能为负数')
        failed = counts['total'] - counts['passed']
        ordinary_deduction = 100 * failed / counts['total']
        critical_deduction = counts['critical_failures'] * penalty
        return ScoreResult(
            config['dimension'], 'scored',
            round(max(0, 100 - ordinary_deduction - critical_deduction), 6),
            max_score=100, version=self.version,
            breakdown=[{'source': config['source'], **counts,
                        'ordinary_deduction': ordinary_deduction,
                        'critical_deduction': critical_deduction}],
        )
```

上述评分器示例按以下规则计算：

```text
普通扣分 = 100 × (total - passed) / total
关键项额外扣分 = critical_failures × critical_penalty
总分 = max(0, 100 - 普通扣分 - 关键项额外扣分)
```

例如 total=10、passed=8、critical_failures=1、critical_penalty=20，得分为 60。关键失败已经包含在普通失败中，这里再额外扣分是本示例**显式选择的加重规则**；若不希望额外处罚，用内置 ImmediateValue 按通过率给分即可。

source_value 拒绝 unavailable/skipped/error 来源；缺字段、非法数据或缺失证据应抛出 ValueError，框架会把本维度标成 unavailable。实现自己的评分器时必须保证有限数值、范围合法，并在 breakdown 记录计算来源；主框架不会对自定义 ScoreResult 自动补做所有数值范围校验。

### 11.7 运行、复评与版本

```sh
harmonyeval run ./config/task.library-plugin.with.yaml --check
harmonyeval run ./config/task.library-plugin.with.yaml

# 验证逻辑新增或改变：复用已有 Agent 工程，重新运行评估。
harmonyeval verify ./config/task.library-plugin.with.yaml --run /absolute/path/to/existing_run

# 只有计分规则变化：复用既有验证指标，不再执行验收工具。
harmonyeval rescore ./config/task.library-plugin.with.yaml --run /absolute/path/to/existing_run
```

执行目标、输入或模型等配置改变后不能直接复用旧生成。新增需要 capture_input 的验证器时，旧运行缺转换前证据，应重新 run。验证器增加后，原有 API/白盒也会随 verify 的完整评估流程重新执行，当前没有仅运行某个 id 的 CLI 参数。

自定义类的 version 会进入对应阶段的指纹。**修改代码、验收脚本或统计口径时主动提升 version**；修改扩展包版本号不会自动替代适配器类 version。自定义 command 脚本内容和任意自定义路径文件目前不会自动哈希；仅修改脚本内容而不改配置/类 version，框架无法据此识别规则已变。rubric_path、prompt_path、workflow_path、skill_path 等已支持的评估文件会参与验证指纹。

结果随主框架统一进入 task-report.json 和 index.html；无需修改报告代码。按上述实现，验收报告与命令日志保存在用例目录的 verification/library_acceptance/，评分中保留扣分明细。

### 11.8 发布扩展前的最小自验证

至少覆盖：全部通过、真实失败、验收报告缺失/坏格式、工具异常/超时、指标不可用、旧报告不被误复用，以及安装后的 entry points 能在新进程被发现。对照组应使用相同验证器、评分规则和外部脚本版本。设备互斥资源只能协调同一评测进程，跨进程执行仍需独立协调设备。

当前框架契约见 harmonyeval/api/；验证调度见 harmonyeval/verification/pipeline.py；source_value 位于 harmonyeval/metrics/sources.py，评分器位于 harmonyeval/metrics/rules/。此扩展方式也适用于一多、安卓迁移和问答场景，自定义类通过输入和配置区分业务，不需要增加新的场景分支。

## 参考实现

- [EvalScope DataAdapter 与贡献基准说明](https://evalscope.readthedocs.io/en/latest/advanced_guides/add_benchmark.html)
- [EvalScope 注册表：Benchmark、Evaluator、Metric、Runner](https://github.com/modelscope/evalscope/blob/main/evalscope/api/registry.py)
- [EvalScope DefaultEvaluator](https://github.com/modelscope/evalscope/blob/main/evalscope/evaluator/evaluator.py)
- [EvalScope Agent 评测说明](https://evalscope.readthedocs.io/en/latest/user_guides/agent/index.html)
- [EvalScope OpenCode Runner](https://github.com/modelscope/evalscope/blob/main/evalscope/agent/external/runners/opencode.py)
- [EvalScope 模型代理](https://github.com/modelscope/evalscope/blob/main/evalscope/agent/external/bridge/server.py)
- [OpenCode Skill 的发现和权限](https://opencode.ai/docs/skills/)
- [OpenCode Plugin 的配置与自动加载](https://opencode.ai/docs/plugins/)
- [OpenCode MCP 的装载和开关](https://opencode.ai/docs/mcp-servers/)
