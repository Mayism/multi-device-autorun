# task.yaml 字段参考

本册供[重构实施指南](harmony-eval-framework-design.md)按需查阅：写配置、实现校验和注册接口时使用。这里列出字段类型、默认值和全部内置类型；具体路径和模型参数见 [YAML 示例册](harmony-eval-task-examples.md)。

**适用范围：**下面是通用框架及当前参考仓库的协议。目标仓库额外已有的 static_eval 字段不能因为未列在表中就删掉、忽略或改成空实现；先按主指南盘点并保留兼容。框架未定义的新业务评分标准，也不能仅凭字段名称自行猜测。

## 配置如何使用

本节用于配置编写和交给其他 Agent 实施。字段名称、大小写、默认值和当前限制以本节为准；[YAML 示例册](harmony-eval-task-examples.md)提供各场景配置，不能将示例值误当成唯一允许值。本文只提供配置契约，不附带可安装的扩展模板。

### 1. 类型、枚举和解析原则

- 表中的“必填”指该字段生效时必须提供；未生效目标块不参与校验和执行。
- 闭合枚举使用本节列出的全部值；注册类型列出当前全部内置值，同时允许通过 Python entry points 新增，禁止在中央调度器写死这些名称。
- 自由字符串、运行时名称和外部服务编码不是闭合枚举。不要把当前模型名、Agent 名、设备名或 AGC 默认编码写成全局允许值列表。
- 时间除字段名明确包含 `Ms`/`_ms` 外均为秒；YAML 布尔值使用 true/false，不写成字符串。
- 字段未被拒绝不等于已实现。当前解析器没有对所有对象执行 additionalProperties=false，部分未知字段会被保留但不被读取；实施和配置均不得依赖这种静默忽略。
- 顶层字段、本框架字段和透传字段分开解释：例如 `model.api_type` 是框架枚举，`CloudTest.taskType` 是服务参数，`UITest.machine` 是现有 Runner 的透传对象。

**全部内置类型与闭合选项总表：**

| 字段 | 完整内置值/允许值 | 性质与说明 |
|---|---|---|
| schema_version | 整数 2 | 闭合版本值；不是字符串 v2 |
| dataset.type | swe-bench-hm-multi-dev、library-migration、android-migration、text-qa | 数据集注册名称，可扩展 |
| target.type | skills、plugin_agent、harmonybot_agent、opencode_agent、knowledge、http_agent | 目标注册名称，可扩展；knowledge_agent 不可执行 |
| execution.engine | opencode、http | 执行器注册名称，可扩展；当前必须与目标匹配 |
| model.api_type | openai_api、openai_compatible | 闭合选项；当前均使用 OpenAI-compatible 模型适配 |
| dataset.layout | cases、repositories | 仅迁移数据集使用；默认 cases |
| execution.opencode.skills[].activation | auto、required | 闭合选项；默认 auto |
| verification[].type | UITest、CloudTest、whiteboxeval、LLM_judge、LibraryAPICount、LibraryTests、LibraryAPICompatibility、ExactMatch、ToolUsage、Command、AGCDetection、SkillVerifier、Workflow | 共 13 个内置流程注册名，大小写精确匹配，可扩展 |
| scoring[].type | BooleanScoring、ImmediateValue、WeightedSummation | 评分器注册名，可扩展 |
| WeightedSummation.mode | deduction、sum | 默认 deduction；当前实现使用相同归一化加权公式和扣分明细 |
| components[].reducer | 省略；或 proportional_deduction | 省略时按 range 归一化；显式 reducer 当前仅定义这一种 |
| response.protocol | json、sse、poll、async | HTTP 协议注册名；poll/async 是同一实现的两个别名，可扩展 |
| report.format | html、json | 配置校验接受的闭合选项；当前报告实现仍同时生成 JSON 和 HTML，见 10 |
| metadata.platform | native、web、rn、flutter | 一多设备 Runner 的闭合枚举，默认 native |
| metadata.device_hap_modules 的键 | phone、tablet、pc | 现有 Runner 的模块映射键，不含 foldable；折叠屏按 phone 部署 |

以下字段**不是固定枚举**：scenario、execution.agent_name、model.name、verification.id、scoring.dimension、dataset.case_ids、device.id/profile、MCP 名称、AGC 类别编号。

### 2. 顶层和活动目标块

| 字段 | 类型 | 必填/默认 | 含义与约束 |
|---|---|---|---|
| schema_version | integer | 默认 2，建议显式填写 | 只支持 2 |
| id | string | 必填 | 任务稳定标识；满足 `^[\w.-]{1,160}$`，不能是单独的点或两个点 |
| scenario | string | 必填 | 场景标签，非空，不使用含 `/` 的选项拼接；不自动决定数据集、验证器或评分规则 |
| description | string | 可选 | 可读任务描述，不参与 type 映射 |
| dataset | object | 必填 | 数据集定义，见 3 |
| target | object | 必填 | 被测对象及装载来源，见 4 |
| experiments | array<object> | 可选，非空，最多 100 组 | 仅 OpenCode；逐组覆盖已定义 MCP 的 enabled，第一组作为比较基准；不能与 without_enable=true 同时使用；完整字段见[实验配置](harmony-eval-implementation-reference.md#71-experiments固定被测能力比较-mcp-开关) |
| 与 target.type 同名的顶层块 | object | 必填 | 实际读取的 rounds/execution/verification/scoring/report；其余块可保留作模板 |
| static_eval | 任意配置对象 | 可选，位于目标块 | 参考仓库仅预留；目标仓库已有实现时保留其字段、调用和计分语义，按主指南第 3 节迁移 |

scenario 的现有约定值为 MultiDev、LibraryMigration、AndroidMigration、KnowledgeEval、QuestionAnswering、APIUpgrade。它们是推荐标签，**不是闭合枚举**；新场景可增加名称。使用 experiments 时，任意场景均可只对声明的 MCP 开关做比较。原有无 experiments 的 KnowledgeEval 直接 Agent 对照保留去除全部 MCP enabled 和允许配置文件路径不同的兼容逻辑。

活动目标块中的通用字段：

| 字段 | 类型 | 必填/默认 | 规则 |
|---|---|---|---|
| rounds | integer | 默认 1 | 1～100；适配器展开轮次，EvalScope repeats 固定 1，不能重复倍增 |
| execution | object | 必填 | 实际执行被测对象的参数 |
| verification | array<object> | 默认空数组 | 评估流程列表；空表示不执行评估，不代表通过 |
| scoring | array<object> | 默认空数组 | 评分规则；无规则就无业务分数，不能补一个默认满分 |
| report | object | 必填 | 需要 output_dir；不能用 null 作为活动任务的有效报告配置 |

例如 target.type=skills 只读取 skills 块，即使 harmonybot_agent 块同时存在也不读取后者。不要用 scenario 或名称前缀猜活动块。

### 3. dataset 和逐用例元数据

| 字段 | 类型 | 必填/默认 | 适用范围及语义 |
|---|---|---|---|
| type | string | 必填 | 四种内置数据集类型或安装的扩展注册名 |
| dir | path string | 必填，必须存在 | 相对 task.yaml 所在目录解析；是否接受文件由数据集适配器决定 |
| case_ids | array<string> | 可选 | 按解析后的 case_id 过滤，不是必然按文件夹名；未知 ID 报错 |
| limit | integer | 可选，正整数 | 在 case_ids 筛选后限制数量，按适配器原有顺序取前 N 个 |
| layout | string | 迁移默认 cases | 只对 library-migration/android-migration 生效 |
| instruction | string | repositories 必填 | 共享公开任务要求；不是提示词文件路径 |
| expected | object | repositories 可选 | 原始仓库布局中共享的验收资料，相对各源工程根目录解析 |
| verification | object | repositories 可选 | 共享的逐流程验收参数；由支持 workflow_settings 的流程合并，不是另一份 verification 列表 |

**四种数据格式：**

1. swe-bench-hm-multi-dev：扫描 dir 直接子目录，每个用例需要 base/ 或 task/、PROMPT.md。提示词按文件原文读取，**不增加迁移目录说明或 Skill 名称**；case_id 优先 metadata.case_id，否则目录名。这个格式不只服务一多，也可用于已有 base+PROMPT+patch 格式的 API 升级评测；不能因为格式名就强制目标为 HarmonyBot。
2. library-migration / android-migration 的 cases 布局：dir 自身有 case.yaml，或直接子目录各有 case.yaml。input.instruction 是文件路径，一般指向 PROMPT.md；适配器读取后追加 base/ 产物目录约定。
3. 上述迁移类型的 repositories 布局：dir 本身为工程，或直接子目录各为工程；公开提示词来自 dataset.instruction。当前识别“dir 本身是工程”的标记为 pubspec.yaml、package.json、build.gradle、build.gradle.kts、settings.gradle；未包含 HarmonyOS 原生工程标记。原生 base/PROMPT 用例优先复用第一种格式。
4. text-qa：dir 是单个 JSON/JSONL 文件或包含这两类问答文件的目录。JSON 顶层为用例数组或含 cases 数组的对象；JSONL 每行一个用例。id、question 为必填非空字符串；reference_answer 为单个标准答案字符串，或使用 reference_answers 字符串数组，两者同时出现必须等价。criteria、reference_documents 给评估使用，metadata 可记录分类和来源；公开输入只包含 case_id/question。参考文件相对数据文件所在目录解析，不要把宿主配置 JSON 放入题集目录。TextDataset 版本已提升为 3，避免将格式契约变化当作旧执行身份。

迁移 case.yaml 字段：

| 字段 | 类型 | 必填/默认 | 含义 |
|---|---|---|---|
| id | string | 默认目录名 | 用例稳定 ID |
| input.project | path string | 必填 | 原工程目录，必须位于该用例目录内 |
| input.instruction | path string | 必填 | 提示词文件路径，必须位于该用例目录内 |
| input.target_template | path string | 可选 | 目标模板；模板复制到 base/，原工程复制到同级 input/ |
| expected.tests | path string | 可选 | 验收资料目录或配置文件，只给评估侧 |
| expected.api_mapping | path string | 可选 | LibraryAPICompatibility 的映射 YAML |
| expected.reference_answers | array<string> | 按评估流程需要 | 问答预期，可用于 ExactMatch/Judge |
| expected.criteria | string 或 array<string> | 按评估流程需要 | Judge 的评价要求 |
| expected.reference_documents | array<path string> | 可选 | 评估参考资料 |
| verification | object | 可选 | 以流程 id 为键；找不到 id 时可按流程 type 取参数，最后由任务 YAML 的流程参数覆盖 |

expected.output_kind 和 expected.output_project 已取消；输入存在这两个旧字段会被迁移适配器拒绝。最终普通工程根固定为每样本 base/，不同用例、轮次、变体不能共写一个工程目录。

一多/原生工程用例执行 UITest 时，metadata.json 的关键字段如下；只被数据集发现不代表元数据已经满足 Runner：

| 字段 | 类型 | 必填/默认 | 约束 |
|---|---|---|---|
| case_id | string | Runner 必填 | 不能仅用 caseName 代替；也决定 dataset.case_ids 引用的 ID |
| platform | string | 默认 native | native/web/rn/flutter |
| base_project | path string | Runner 必填 | 原工程相对路径，通常 base 或 task；评估临时工程会统一改为 base |
| test_patch / golden_patch | path string | Runner 必填 | 用例内存在的相对补丁路径；不能只给文件却不声明字段 |
| test_case_timeout_ms | integer | 默认 15000 | 正整数，单个测试用例超时，毫秒 |
| fail_to_pass / pass_to_pass | array<string> | 默认空数组 | 测试身份，如 Suite#test；不是用于选择流程 type 的枚举 |
| device_test_suites | object | 可选 | 设备 ID→含 suite 字段的对象数组；存在时选择这些设备/套件，不能为空配置 |
| enabled_devices | array<string> | 可选 | 无 device_test_suites 时的设备选择；不填则使用机器设备列表 |
| device_hap_modules | object | 可选 | phone/tablet/pc→HAP 模块名；不能写未知映射键 |
| bundle_name_isolation | boolean | 可选 | 复用 Runner 的包名隔离能力 |
| rn_build.bundle_commands | array<string> | 仅 RN 可选 | 现有 RN Runner 的打包命令约定；不能与通用 command 参数数组混为一谈 |

原始 metadata 的其他业务描述字段可保留，但不自动替代上述 Runner 字段。golden/test/metadata 在 Agent 停止后归档，UITest 结果落在 verification/流程id/，不能因为没有旧 .ohostest-runs 名称就判断未执行。

### 4. target：插件、Skill、Agent 和 HTTP 目标

| target.type | 必填字段 | 对应 engine | 同名目标块语义 |
|---|---|---|---|
| skills | dir | opencode | 被测 Skill；可选择一个或多个 Skill，agent_name 通常为 build |
| plugin_agent | dir | opencode | 被测 Plugin 包/本地入口；不要求它注册与插件同名的 Agent |
| harmonybot_agent | dir | opencode | HarmonyBot 扩展来源目录，适配器定位实际 Bundle 与内置可执行文件 |
| opencode_agent | 无额外必填字段 | opencode | 独立 OpenCode 的实际注册 Agent；binary/config_path 放在 execution.opencode |
| knowledge | 无额外必填字段 | http | 智能问答后端 URL；不是 MCP 知识库配置 |
| http_agent | 无额外必填字段 | http | 通用 HTTP Agent；与 knowledge 共用请求协议适配器 |

target 公共/插件专用字段：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| type | 注册名称 | 无，必填 | 精确选择目标适配器及顶层活动块 |
| dir | path string | 由类型决定是否必填 | 相对任务文件解析；Skill 指 SKILL.md 所在目录或包含 Skill 子目录的目录 |
| id | string | Plugin 默认目录名 | 被测插件可选稳定标识，用于识别/清理插件归属；不是 Agent 名 |
| entry | path string | package.json.main，再退回 index.js | 仅被测 Plugin 使用，相对插件目录；本地单入口文件无需再填 |
| options | object/JSON 值 | 无 | 仅被测 Plugin 的初始化参数，原样交给插件 |

**Plugin 与 Agent 是不同对象。** target.dir 决定加载插件；execution.agent_name 决定执行哪个注册 Agent。hmos-library-adapter-fast 恰好既是插件名，也是它注册的 primary Agent ID；不得推广成“所有插件名都能填 agent_name”。该 API 升级适配目录则是 Skill，应使用 skills+build，不能因为有 package.json 就误判为 OpenCode Plugin。

### 5. execution、环境与模型

| 字段 | 类型 | 必填/默认 | 行为 |
|---|---|---|---|
| engine | 注册名称 | 本地目标默认 opencode；HTTP 目标默认 http | 只支持对应目标的引擎，不凭字符串前缀猜宿主 |
| agent_name | string | opencode 必填 | OpenCode 实际 Agent ID，不是闭合枚举。例 build、d2h、harmonyos-multi-device；历史别名“一多适配Agent”会映射为 harmonyos-multi-device |
| model | object | opencode 必填 | 正式生成模型，由 EvalScope 模型代理接入 |
| timeout | integer | 默认 900 | 正整数，执行总预算，秒；不等于验证总预算 |
| idle_timeout | integer | 默认 300 | 正整数，仅 opencode 主 CLI stdout 静默计时；不能当成子 Agent 全局心跳 |
| concurrency | integer | 默认 1 | 样本并发数，正整数；设备仍需资源锁协调 |
| without_enable | boolean | skills/plugin_agent 默认 false | 是否启用 without 对比测试；true 自动先跑不加载对象的 without，再跑加载对象的 with 并比较；false/省略只跑 with。仅 skills/plugin_agent，不与 MCP experiments 同时启用 |
| without_agent_name | string | 可选 | without 组的宿主 Agent；Plugin 默认 build，Skill 默认沿用 agent_name；仅 skills/plugin_agent |
| enviroment | object | 默认空对象 | 沿用当前拼写；全部非空值按目录路径解析，不放 URL、开关或普通文本 |
| opencode | object | 默认空对象，可整体省略 | 仅执行引擎的 binary/config_path 和额外能力配置，不是任务配置文件 |

enviroment 的已定义字段：deveco_home→DEVECO_HOME，sdk_home→DEVECO_SDK_HOME，java_home→JAVA_HOME，flutter_home→FLUTTER_HOME，并补充相应 PATH。deveco_home 可给应用根或 Contents，适配器按本机目录归一化。其他目录名虽可能通过目录存在检查，但**不会自动变成任意环境变量**；添加新环境能力应扩展明确映射。

模型对象（execution.model、Judge.model、SkillVerifier.model 共用）：

| 字段 | 类型 | 必填/默认 | 约束 |
|---|---|---|---|
| api_type | string | 默认 openai_api | openai_api 或 openai_compatible；不是模型供应商枚举 |
| name | string | 必填 | 服务端支持的实际模型 ID，自由字符串；glm-5.3/qwen-plus 仅为示例 |
| base_url | string | 必填 | HTTP(S) 模型 API 基址；与 HTTP Agent 的 http_url 不同 |
| api_key | string | 必填 | 环境变量名，或兼容的非空明文密钥；环境变量名模式为 `[A-Za-z_][A-Za-z0-9_]*`。明文加载后换成进程内引用，快照脱敏 |
| max_tokens | integer | 默认 4096 | 生成预算；不由模型名称自动推导 |
| temperature | number | 默认 0 | 发给实际模型服务的参数；可用范围由服务定义，不另造全局枚举 |
| retries | integer | 默认 1 | 模型层重试参数，不是恢复失败用例的功能 |
| seed | integer | 可选 | 服务支持时使用；不能声称所有服务都保证可复现 |

当前代码对部分生成参数仅透传，实施时应做基本类型/数值合法性校验，不能声称现有 schema 已完整限制了模型供应商的所有参数范围。不支持的 api_type 不得偷偷切换成其他协议。

### 6. execution.opencode 与 Skill/Plugin 开关

| 字段 | 类型 | 默认/规则 |
|---|---|---|
| binary | path string | 独立 OpenCode 默认从 PATH 查找；HarmonyBot 仍从 target.dir 定位 Bundle，不以该字段切换发行版 |
| config_path | path string | 可选；相对任务文件解析，将该 JSON/JSONC 合并到实际宿主配置的私有副本 |
| skills | array<object> | 可选；skills 目标未填写时，默认选取 target.dir 下的 Skill，activation=auto |
| plugins | array<string/object> | 可选的额外宿主插件；plugin_agent 目标禁止用它重复声明被测插件，应使用 target.dir/entry/options |

skills 条目字段：path 是 Skill 目录（省略时可取 target.dir），name 是 SKILL.md frontmatter 的名称过滤器，id 为可读配置标识；activation 只能是 auto/required，默认 auto。auto 表示可被模型自然发现，**不保证调用**；required 表示执行后必须观测到成功的 skill(name) 调用，否则本次执行失败，不是绕过模型自动执行 Skill 内容。

额外 plugins 条目可为固定版本包字符串，或含 id、package/source、entry、options 的对象；source 为本地目录/入口路径，entry 相对 source。包必须固定版本，例如 pkg@1.2.3；当前代码只做有限字符串检查，不把 @latest/@* 或不固定范围作为可复现实验配置。

MCP 完整定义只放在实际 opencode.json 的 mcp 节点，按服务器名配置 type/local command 或 remote url、enabled 等引擎参数。可选的顶层 experiments 仅覆盖已定义服务器的 enabled，不复制 URL/command，不创建 knowledge 包装。MCP enabled 是布尔值，知识库对照保留同一 Agent，仅改变声明的 MCP 开关；without_enable 不控制 MCP。预检可记录配置，不等于已建立连接或答案确实使用知识。

### 7. verification 通用字段与结果引用

| 字段 | 类型 | 默认/规则 |
|---|---|---|
| type | 注册名称 | 必填；完整内置值见 1 |
| id | string | 省略时取 type；同一层流程中唯一，满足任务 id 的标识规则。相同 type 使用多次必须显式区分 id |
| depends_on | array<string> | 默认空；引用同级 id，禁止不存在节点和环。前置状态必须 completed 才继续，不代表前置业务指标全部通过 |
| requires_execution | boolean | 默认 true；Agent 未完成时不评估。失败分析类流程可显式设 false，自行处理部分工程 |
| resources | array<string> | 默认空；使用 Workflow 默认 requirements 时生效。UITest/CloudTest 自己声明资源，不自动叠加这个数组 |
| timeout | integer | **没有统一默认**；具体流程决定含义/默认值，不能只在通用解析器中设一个值覆盖全部流程 |

id 是结果命名空间：例如 id=ui 的结果写入 verification/ui/，评分 source=ui.metrics.pass_rate；type=UITest 才决定使用哪个验证器。id、dimension、命令文件名都不参与 type 的注册映射。

验证结果结构为 verifier_id、status、metrics、dimensions、findings、evidence、error、version。当前内置流程主要返回 completed、failed、unavailable、skipped；评分读取器也把 error 状态当不可用。业务断言失败可以有 completed+低通过率，或者 failed+可用指标，不能把这两种情况误当成工具缺失。结果状态是本框架约定，AGC 远端状态字符串另由云协议解释。

补充阶段状态：当前 ExecutionResult 使用 completed、failed、timed_out、error、interrupted；ScoreResult 使用 scored、unavailable。它们是输出协议值，不是 task.yaml 中应填写的验证器/评分器类型。verification 没有通用 enabled 开关，不能用 enabled=false 假定某流程被禁用。

#### 7.1. UITest

| 参数 | 类型 | 必填/默认 |
|---|---|---|
| devices | array<object> | 必须有实际设备；空列表返回 unavailable |
| devices[].id | string | 必填，需与 metadata 中设备选择一致；常见 phone/foldable/tablet，但不是全局闭合枚举 |
| devices[].profile | string | 模拟器配置名；start_emulator=true 时需指向实际部署配置 |
| devices[].target | string | 必填，如 127.0.0.1:15001，现有 Runner 校验格式 |
| devices[].hdc_port | integer | 默认 7035；不会从 target 自动推导，建议显式填写 |
| devices[].start_emulator | boolean | 默认 false |
| deveco_home | path string | 可继承 execution.enviroment.deveco_home |
| flutter_home | path string | 可继承执行环境，用于 Flutter Runner |
| emulator_deployed_dir | path string | 启动模拟器时需要；由机器实际部署位置决定 |
| timeout | integer，秒 | 外部 Runner 默认 7200；未填时机器 timeoutMs 的默认来自 120 秒，当前两个默认不一致，正式配置应显式填写 |
| paths | object | 显式覆盖推导工具路径；常用键 hvigorw、ohpm、hdc、emulatorBin、emulatorDeployedDir、flutter |
| machine | object | 现有 Runner 配置透传，最后按顶层键覆盖自动生成配置；不是深合并。避免与 devices/paths 重复声明产生资源锁不一致 |

machine 的常用透传字段包括 product、module、bundleName、testModule、testRunner、testClass、timeoutMs、build、artifacts；build 内是 mode/appTask/testTask，artifacts 内是 appHap/testHap。默认构建任务来自现有 Runner，不将任意 Hvigor task 名列成框架枚举。设备锁当前只在单评测进程内按 target 协调。

输出指标：build_passed、tests_run、passes、pass_rate（0～1 或缺失）、all_tests_passed。编译、安装、应用测试补丁、设备执行由此流程内部完成；YAML 不另加 build 验证节点。

#### 7.2. CloudTest

| 参数 | 类型 | 默认/规则 |
|---|---|---|
| teamId | string | 可从 AGC_TEAM_ID 取值 |
| projectId | string | 可从 AGC_PROJECT_ID 取值 |
| testCategories | array<object> | 默认 `[{category: 24, timeSpan: 60}]`；category 是 AGC 服务编码，timeSpan 为服务测试时长 |
| test_categories | array<integer> | 简写；非空时转换为上面的结构，timeSpan 固定 60 |
| test_category | string | 可选逗号分隔标签；必须同时提供 category_mapping，不内置 UI/Security 等文本到编号的猜测 |
| category_mapping | object | 标签→AGC 数字类别；由所用服务版本确定，不是固定通用枚举 |
| product / buildMode | string | 默认 default/release；实际值由工程及 Hvigor 支持的配置决定 |
| buildTimeoutSec | number，秒 | 默认 1800，至少 60 |
| analyzeTimeoutSec | number，秒 | 默认 900，至少 30 |
| taskTimeoutSec | number，秒 | 默认 7200，至少 60；云任务等待时间，不等于通用 timeout |
| pollIntervalSec | number，秒 | 默认 60，至少 5 |
| signingConfigs | array<object> | 可选；注入评估构建副本，未提供时使用工程自身签名配置 |
| bundleName | string | 可选；覆盖评估副本的包名，不修改 Agent 原工程 |
| appClass | string | 默认 Tool；AGC 参数，不是框架闭合枚举 |
| taskType | number | 默认 28；AGC 参数，不是 verification.type |
| testItem | string | 默认 17179869185；AGC 参数，不作为通用枚举扩展 |
| proxy | string | 可由 AGC_PROXY 提供 |

认证从任务 YAML 所在目录的 agc-cookie.txt 非空内容读取，否则用 AGC_AUTH_INFO；不要以为在流程里增加 api_key/agcAuthInfo 任意字段就会被当前实现读取。teamId/projectId/认证缺失时不可运行云测试；--check 当前不完整校验这些云端前置条件。

signingConfigs 直接承载 DevEco 签名对象：例如 name/type/material，material 可包含 storeFile、profile、certpath、storePassword、keyAlias、keyPassword、signAlg 等工程要求的字段。三个材料路径相对任务文件解析；其余参数由构建工具解释，不假造框架签名枚举。文档与提交不得包含真实密码、cookie 或 token。

若同时配置类别字段，当前 test_category 标签先决定转换结果，其次 test_categories；非空转换结果会覆盖 testCategories。建议只选一种。编号 24 是当前默认，**不是已经列全的云服务类别**；新增服务类别应从实际接口确认，不能凭本设计猜编号。

该流程显式传递 execution.enviroment 中的 DevEco/SDK/Java 和 ohpm 路径给构建层；不依赖启动终端恰好全局安装 ohpm。输出 passed、pass_rate、device_count、device_passed、rule_failed、issue_count；passed 同时要求设备全通过、规则无失败且无问题。

CloudTest 条目只要被配置就会启用，当前会强制给底层客户端 enabled=true，填写 enabled=false 不能关闭云提交。暂不评云测试时应从活动 verification 中移除该条目，并同步移除或调整引用它的评分规则。

#### 7.3. whiteboxeval 和 LLM_judge

| 参数 | 类型 | 默认/规则 |
|---|---|---|
| model | object | 可选，省略继承 execution.model；HTTP 目标通常需要显式提供裁判模型 |
| prompt_path | path string | 可选；优先于 rubric_path，作为评价提示词 |
| rubric_path | path string | 可选；白盒评分规则，支持 MD 表格或含 dimensions 的 YAML |
| dimensions | array<object> | 可选；元素 name/max_score；白盒省略时可从 rubric 读取，或使用默认 40/30/20/10 四维 |
| timeout | integer，秒 | 默认 180，模型评价请求预算 |
| max_evidence_chars | integer | 白盒默认 100000，超出返回 unavailable，不静默截断并假称完整评估 |

白盒收集 question、Agent answer、目标工程源码和 change.patch；LLM_judge 使用问答预期和参考资料。LLM_judge 无 prompt_path/rubric 时，需要 reference_answers 或 criteria。二者均要求 score 0～100 和非空 reason；白盒另要求非空 dimensions，维度满分合计 100，维度分合法，总分不能高于维度得分之和。空回复或无法解析的 JSON 不评分，原始回复保留在 judge.json。

输出 metrics.score、metrics.total_score、dimensions、findings。**当前不实现 input: execution.answer 这样的动态输入选择器**，增加 input 字段不会改变取证范围。通用白盒评审也不是旧 ArkAnalyzer 规则引擎的完整等价替代，不能声称已跑所有静态分析器。

#### 7.4. LibraryAPICount

source_paths/target_paths 是非空字符串数组，分别相对源工程和目标工程；source_languages/target_languages 是非空数组，元素完整枚举为 dart、typescript、javascript、java、kotlin。ETS 兼容语法使用 typescript；**不接受 arkts/ets 语言别名**。

未填范围时使用自动选取规则；转换前由 capture_input 固定 input-evidence.json。输出 count_match、total_match、source_total、target_total、total_delta、count_consistency；分类为 types/callables/properties。计分通常读取 count_consistency 后乘 100。数量指标不验证签名对应、功能等价或设备表现。

#### 7.5. LibraryTests 和 LibraryAPICompatibility

LibraryTests 参数：build_command 和 test_command 是必需的非空字符串参数数组；timeout 默认每条命令 600 秒；tests_destination 默认 evaluation-tests；junit_path 相对评估工程；exit_code_is_test_result 默认不启用，仅显式 true 时将整条命令视作一个通过率指标。

这些参数可来自用例 verification.<id>，其次 verification.<type>，或 expected.tests 中 verification.yaml，最后由当前任务条目覆盖。输出 build_passed、all_tests_passed、pass_rate；提供 JUnit 时还输出 tests_run、passes。构建失败保留失败指标，无报告不能假造逐项测试通过率。

LibraryAPICompatibility 读取 expected.api_mapping 的 YAML：顶层 apis 数组，每条包含 source（说明）、target（目标符号）、可选 file、required_symbols、weight。weight 默认 1 且必须大于 0；file 相对目标工程；required_symbols 省略时使用 target。输出 coverage，是目标符号文本覆盖率，不是完整 API 语义等价证明。

#### 7.6. ExactMatch、ToolUsage、Command、AGCDetection

| 流程 | 配置与输出 |
|---|---|
| ExactMatch | 无专用必填参数；需要 case.expected.reference_answers。去掉答案首尾空白后精确匹配任一参考，输出 passed 和 score（100/0） |
| ToolUsage | target_mcp 为服务器名；按已归档工具名的 `目标MCP名_` 前缀统计，输出 configured/enabled/attempted/succeeded。mode 只约定 observe，当前没有其他执行模式，也不验证资料是否被答案引用 |
| Command | command 必填，必须是字符串参数数组；timeout 默认 600 秒。在工程副本运行，退出码 0→metrics.passed=true，其他退出码 false；超时/工具异常→unavailable |
| AGCDetection | command 或 http_url 至少其一；两者都有时先用 command。HTTP 复用第 9 节协议，并将提取出的答案字符串再解析为 JSON，要求 passed 是布尔值；不等于 CloudTest 服务 |

Command 与构建/测试命令仅替换 `${project}`、`${output}`。不支持在这些命令中使用 `${case.question}` 或 `${env:...}`，也不把单个字符串自动送进 shell。

#### 7.7. SkillVerifier

| 参数 | 类型 | 默认/规则 |
|---|---|---|
| skill_path | path string | 必填，验证 Skill 目录；不是被测适配 Skill 的自动别名 |
| model | object | **必填**；与 whiteboxeval 可省略不同，当前 schema 要求显式声明 |
| agent_name | string | 默认 build；独立 OpenCode 中可用的 Agent |
| timeout | integer，秒 | 默认 300；该内部审阅会话的 idle_timeout 当前固定 120 |
| result_schema | JSON Schema object | 默认要求对象有 metrics 字段且 metrics 是对象；建议进一步约束具体指标类型/范围 |

在独立评估会话和工程副本中加载目标验证 Skill，并检查成功的 skill 调用。当前最终回答必须是含 metrics 的 JSON，可另含 dimensions/findings；**不会自动读取 Skill 生成的任意 MD/HTML 文件进行评分**。若按文件评分，需要新增报告解析适配或让 Skill 同时返回约定 JSON。

这是完整的可选评估流程，不是所有被测 Skill 的 activation 检查。当前内部会话重写 execution，没有完整继承父任务 enviroment/opencode 覆盖；需要专用 SDK 或特定宿主的评估 Skill，应先补齐环境透传并验证，不能仅凭此类型宣称任意 Skill 均可运行。

#### 7.8. Workflow

steps 为 verification 条目数组，或 workflow_path 指向含 steps 的 YAML，至少一种。外部文件的相对路径按该文件目录解析；当前内嵌 steps/metrics 已存在时优先使用已有值。最大嵌套深度 16，循环引用拒绝。

metrics 是“对外指标名→内部流程结果路径”的对象，如 `{score: judge.metrics.score}`；外层评分读取 `组合id.metrics.score`，不直接假定内部 id 是顶层评分命名空间。内部结果保留在 evidence。steps 内可重复使用相同验证器类型，但必须有不同 id。

### 8. scoring：规则名、来源和报告维度

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| dimension | string | 必填，同一任务唯一 | 满足 id 标识规则；报告列名，自由命名，不参与规则分派 |
| type | 注册名称 | 必填 | 三个内置评分器或已安装扩展的注册名 |
| source / cap_source | string | 由具体规则要求 | 点分路径；第一段必须是当前 verification 的 id，不支持公式/通配 JSONPath |

source 可取 `ui.metrics.pass_rate`、`code.dimensions`、`code.dimensions.0.score` 等；中间的数字段可索引数组。当前配置期只校验第一段的流程 ID，剩余字段在计分时核验。缺失、None、无效数值或 unavailable/skipped/error 来源产生 unavailable 分数，不转换成 0。failed 流程仍可提供真实业务失败指标供计分。

| type | 参数 | 默认与限制 |
|---|---|---|
| BooleanScoring | all 为非空数组；每项 source、equals 必填；pass_score/fail_score 可选 | 所有值与 equals 相等得 pass_score，否则 fail_score；默认 100/0。equals 是目标值，不是额外规则类型 |
| ImmediateValue | source 必填；scale、max_score 可选 | score=原值×scale，scale 默认 1，max_score 默认 100；结果必须是有限数值且在 0～max_score 内 |
| WeightedSummation | components 非空；每项 source/weight 必填；base_score/mode 可选 | base_score 默认 100；weight 非负且合计 1；mode=deduction/sum。细项规则见下 |

components 条目字段：

| 字段 | 类型 | 规则 |
|---|---|---|
| name | string | 可选，仅用于扣分明细；省略取 source |
| source | string | 必填，指标值或维度数组路径 |
| weight | number | 必填，所有条目合计 1 |
| range | 两个数值的数组 | 普通数值指标默认 [0,100]；通过率需显式 [0,1]，上界必须大于下界，原值不能越界 |
| reducer | string | 省略按 range 计分；proportional_deduction 读取维度数组 |
| cap_source | string | 维度模式可选，白盒总分封顶来源；不是普通指标的额外扣分项 |

维度数组每项 name/score/max_score，score 在 0～max_score，max_score 必须大于 0；按 max_score 比例分配当前条目的权重分值。cap_source 只施加总分封顶，不能把同一个白盒处罚重复扣除。显式未知 reducer 名没有定义，不应利用当前代码会落入普通分支的行为。

scoring.missing 在示例中可保留 unavailable 作为口径说明；当前 calculate_scores 无论是否写该字段，缺证据都返回 unavailable，**没有 missing=zero/ignore/error 等已实现模式**。L1/L2/L3、uitest、cloud_test 均只是 dimension 名称；不要把 UITest/CloudTest 填到 scoring.type，也不要让维度名自动决定评估流程。

### 9. HTTP 智能问答协议字段

这些字段只对 execution.engine=http 或采用同一 HTTP 协议的验证器有效：

| 字段 | 类型 | 必填/默认 |
|---|---|---|
| http_url | string | 必填，HTTP(S) URL |
| method | string | 默认 POST；由后端定义，常见 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS，不是项目自己的闭合枚举 |
| request.headers | object<string,string> | 可选，认证通常用 `${env:AGENT_TOKEN}` |
| request.json | JSON 值 | 默认包含 question；是否有请求体由服务协议决定 |
| response.protocol | 注册名称 | 默认 json；完整值 json/sse/poll/async |
| response.answer_path | string | 默认 answer；点分提取字段，可用数字索引数组；结果必须为非空字符串 |
| response.session_id_path | string | 可选，仅提取后端实际返回的会话 ID，不创建多轮会话调度 |
| response.event_answer_path | string | SSE 默认 delta；从每个 data JSON 事件提取增量并拼接，SSE 适配器的最终 answer 是平面字段 |
| response.poll | object | poll/async 必填，见下 |

response.poll 的 url 必填，支持 `${job_id}` 和相对提交 URL；job_id_path 默认 job_id（从首次提交返回读取）；method 默认 GET；request 默认继承首次 headers；status_path 默认 status；completed 默认 [completed, success]；failed 默认 [failed, error]；interval 默认 1 秒。这些 completed/failed 列表是后端状态映射，可自定义，不是本框架业务结果状态枚举。

HTTP 请求替换仅支持 `${case.question}`、`${case.case_id}`、`${env:环境变量名}`，以及轮询提供的 `${job_id}`；禁止 eval 表达式或自动读取任意用例评估资料。后端模型、token、内部工具不返回时标为 unknown，不能沿用本地 generation model 伪造远端信息。

### 10. report、废弃字段及内部字段

| 字段 | 类型 | 必填/默认 | 行为 |
|---|---|---|---|
| report.output_dir | path string | 必填 | 相对任务文件解析；实际目录下再创建唯一 run_id |
| report.format | string | 默认 html；允许 html/json | 当前 write_task_report 总写 task-report.json 和 index.html，尚未按 json 值禁止生成 HTML；不要将其解释成两套不同报告源 |

不能再使用的字段：runtime_config、execution.runtime、迁移 expected.output_kind/output_project；不要新增 comparison 来代替 without_enable，不将 distribution 与 engine 重复配置。历史 knowledge_agent/host_target/without_process 仅保留未启用模板，不是本地 MCP 评测入口。scoring_preset 暂无自动展开实现；ToolUsage.mode 除观测外无其他行为；Judge.input 选择器不存在。

source、base_dir、active、variant 是生成的内部字段，用户不需要填写，也不能用它们覆盖运行身份。单组任务的 variant 为 with，不代表 MCP 已启用。without_enable=true 自动展开 without、with 两个实验子组；字段不再表示本次只跑关闭组。配置 experiments 后子任务的 variant 为对应实验 ID；experiment 是展开后的运行时字段，不能在 YAML 中直接填写。

### 11. 最小引用示例

```yaml
# 加入当前活动目标块中；这是字段关系片段，不是完整任务。
verification:
  - id: phone_ui
    type: UITest
    # 设备、工具链等必需参数仍须补齐。
  - id: cloud
    type: CloudTest
    testCategories:
      - category: 24
        timeSpan: 60
scoring:
  - dimension: local_result
    type: BooleanScoring
    all:
      - source: phone_ui.metrics.build_passed
        equals: true
      - source: phone_ui.metrics.all_tests_passed
        equals: true
  - dimension: cloud_result
    type: BooleanScoring
    all:
      - source: cloud.metrics.passed
        equals: true
```

将 dimension 改名不会更换评分器；将 id 改名必须同步 source/depends_on 和相关流程参数引用；将 type 改名则必须存在对应注册实现。command 的文件名或插件的包名均不会自动注册评分规则。
