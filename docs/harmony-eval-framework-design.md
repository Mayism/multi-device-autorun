# HarmonyEval 重构实施指南

更新日期：2026-11-02。**本文用于指导另一个仓库的 Agent 完成重构。**那个仓库已有 static_eval 和一多适配评测，目录结构类似本仓库通用框架提交前的 develop。

目标是保住已有能力，把“主要围绕一多运行的工具”改成“由 task.yaml 选择用例、被测能力、验证方法和评分规则的通用评测框架”。后续接入三方库转换、Android 转鸿蒙、MCP 对照和 HTTP 问答时，应主要增加配置或适配器。

## 1. 怎么读，以及先确认什么

先读本文，按第 5 节的阶段实施。写配置和具体适配器时，再查配套文档：

| 文档 | 什么时候看 |
|---|---|
| 本文 | 确定要改什么、先后顺序、保留什么、怎么验收 |
| [字段参考](harmony-eval-config-reference.md) | 查 task.yaml 的必填项、默认值、全部内置类型和精确拼写 |
| [18 份 YAML 示例](harmony-eval-task-examples.md) | 为某个场景选择相近配置，不必通读所有示例 |
| [实现参考](harmony-eval-implementation-reference.md) | 查 EvalScope 桥接、模型代理、验证器、缓存和报告的实现细节 |
| [扩展开发指南](harmony-eval-extension-guide.md) | 实现新的验证器或评分器，注册和安装 Python 扩展包 |
| [开发 Skill](../.agents/skills/harmonyeval/SKILL.md) | 开发和代码审查时检查架构边界 |

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

先实现内置注册和参数校验，再支持独立包 entry points；同名重复注册报错。增加外部扩展不要求修改中央类型表。参考实现还提供 harmonyeval.http_protocols，以及历史 harmony_eval.* 入口组兼容，完整说明见扩展指南。

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

- **做什么**：实现 verify、rescore、compare；分别记录输入、执行、验证和评分的摘要，用来判断旧结果能否复用。experiments 在临时运行副本覆盖 MCP 开关。
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
- **without_enable** 只关闭目标 Skill/Plugin。对 MCP 开关用配置文件或 experiments；测 HarmonyBot Agent 本身不用自动生成“没有 Agent”的组。
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

模型部分复用 EvalScope Model/ModelAPI 兼容访问；OpenCode 经模型代理访问配置的模型，独立裁判也走同一模型兼容层。能力装载、用例执行、验证、评分仍由各自模块负责，模型模块不读取业务目录来编排测试。完整桥接和原生类型见实现参考，不必重新造一套 EvalScope。

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
请按《HarmonyEval 重构实施指南》修改当前目标仓库。

目标仓库已有 static_eval 和一多适配评测，结构类似旧 develop；不要假定它已经包含参考仓库的新框架。
先阅读当前代码，列出入口、配置、输出、测试以及旧模块到新目录的迁移映射。
特别确认 static_eval 实际评测对象、调用时机、执行次数、判据和评分；保留真实实现，不能照抄参考仓库的预留行为。

按主指南第5节分阶段实施：骨架与契约 → 保留静态评价 → 提取一多单用例执行与验证 → 接 EvalScope → 扩展其他场景 → 复评/对照 → 清理旧结构。
统一主入口为 harmonyeval run task.yaml，源码放根目录 harmonyeval。
新增场景通过用例集、执行、验证、评分适配器连接，不复制主调度器或为 scenario 添加专用分支。
完整字段查《字段参考》，各场景配置查《18份YAML示例》，具体桥接查《实现参考》；本机路径和密钥不要照抄。

边检查边实施，每阶段做相应自验证；业务口径无法从代码确定时再提出具体问题。
结束时列出已改内容、保留的 static_eval/一多能力、实际验证命令和结果、尚需外部环境才能验证的项目。
```

移交时附上本文、三份配套参考文档，以及需要借鉴的扩展指南/Skill。若只给一个 Markdown 文件而不提供被链接的内容，实施 Agent 无法获得完整字段与18份配置。参考仓库源码可访问时同时给出路径或版本；不可访问时，Agent 按接口和验收要求在目标仓库实现，缺业务资料明确说明。
