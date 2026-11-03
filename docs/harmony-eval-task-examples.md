# YAML 配置说明与场景示例

更新日期：2026-11-03。本文件集中回答“怎样写 task.yaml、怎样运行、每种场景怎么配”；框架架构、迁移步骤与扩展代码统一见[框架设计与重构指南](harmony-eval-framework-design.md)。

## 目录

- [1. 安装与运行](#1-安装与运行)
- [2. 字段说明与枚举](#2-字段说明与枚举)
- [3. 一次任务怎样跑对照](#3-一次任务怎样跑对照)
- [4. 选择场景配置](#4-选择场景配置)
- [5. 完整 YAML 示例](#5-完整-yaml-示例)

只运行现有任务：读第1节，再从第4节选择文件。修改字段：查第2节。需要一次执行有无能力两组：先看第3节。

## 1. 安装与运行

建议 Python 3.12，最低3.10。在仓库根目录创建并进入虚拟环境：

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[eval]'
```

Windows PowerShell 用 `py -3.12 -m venv .venv`，随后 `.\.venv\Scripts\Activate.ps1`。主命令是 **harmonyeval，不带中划线**；旧 Python 3.9 的 harmony-eval/pyautorun 启动脚本不能用于新框架。从旧安装升级时，在原环境卸载 multi-device-autorun-python，再在新环境安装当前工程。

```sh
harmonyeval plan ./config/task.yaml
harmonyeval run ./config/task.yaml --check
harmonyeval run ./config/task.yaml
```

也可用当前环境的 `python -m harmonyeval`。模型密钥使用环境变量名，例如 api_key: ZHIPU_API_KEY，并在运行终端设置该变量；不要把真实凭据复制到共享文档。

plan/--check 检查结构、依赖及相应能力准备，不请求生成模型，也不证明远端授权、MCP调用、设备或云测试成功。每个源 YAML 的相对路径按该文件所在目录解释，移动配置时一起调整路径。

```sh
harmonyeval verify ./config/task.yaml --run /path/to/single-run
harmonyeval rescore ./config/task.yaml --run /path/to/single-run
harmonyeval compare /path/to/left-run /path/to/right-run --output ./output/comparison
```

verify 重做验证，rescore 只重算分数；输入、模型或被测能力变化时重新 run。自动双组/MCP实验的 --run 指 experiments/<组ID>/ 单组子目录，比较差值为右组减左组。

## 2. 字段说明与枚举

target.type 选择同名活动块；dataset 只决定数据怎么读，scenario 是标签，不选择专用执行流水线。下表列出完整字段和内置值，可扩展的 type 不应写死在中央调度器。

**static_eval：**当前参考仓库只预留该字段；迁移另一个已有静态评测的仓库时，应保留其真实配置和行为，不能照抄示例的空对象。参见[框架指南第3节](harmony-eval-framework-design.md#3-已有能力怎样保留尤其是-static_eval)。

### 2.1 类型、枚举和解析原则

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
| report.format | html、json | 配置校验接受的闭合选项；当前报告实现仍同时生成 JSON 和 HTML，见2.10 |
| metadata.platform | native、web、rn、flutter | 一多设备 Runner 的闭合枚举，默认 native |
| metadata.device_hap_modules 的键 | phone、tablet、pc | 现有 Runner 的模块映射键，不含 foldable；折叠屏按 phone 部署 |

以下字段**不是固定枚举**：scenario、execution.agent_name、model.name、verification.id、scoring.dimension、dataset.case_ids、device.id/profile、MCP 名称、AGC 类别编号。

### 2.2 顶层和活动目标块

| 字段 | 类型 | 必填/默认 | 含义与约束 |
|---|---|---|---|
| schema_version | integer | 默认 2，建议显式填写 | 只支持 2 |
| id | string | 必填 | 任务稳定标识；满足 `^[\w.-]{1,160}$`，不能是单独的点或两个点 |
| scenario | string | 必填 | 场景标签，非空，不使用含 `/` 的选项拼接；不自动决定数据集、验证器或评分规则 |
| description | string | 可选 | 可读任务描述，不参与 type 映射 |
| dataset | object | 必填 | 数据集定义，见2.3 |
| target | object | 必填 | 被测对象及装载来源，见2.4 |
| experiments | array<object> | 可选，非空，最多 100 组 | 仅 OpenCode；逐组覆盖已定义 MCP 的 enabled，第一组作为比较基准；不能与 without_enable=true 同时使用；完整字段见[实验配置](harmony-eval-task-examples.md#32-mcp-有无对照) |
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

### 2.3 dataset 和逐用例元数据

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

### 2.4 target：插件、Skill、Agent 和 HTTP 目标

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

### 2.5 execution、环境与模型

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

### 2.6 execution.opencode 与 Skill/Plugin 开关

| 字段 | 类型 | 默认/规则 |
|---|---|---|
| binary | path string | 独立 OpenCode 默认从 PATH 查找；HarmonyBot 仍从 target.dir 定位 Bundle，不以该字段切换发行版 |
| config_path | path string | 可选；相对任务文件解析，将该 JSON/JSONC 合并到实际宿主配置的私有副本 |
| skills | array<object> | 可选；skills 目标未填写时，默认选取 target.dir 下的 Skill，activation=auto |
| plugins | array<string/object> | 可选的额外宿主插件；plugin_agent 目标禁止用它重复声明被测插件，应使用 target.dir/entry/options |

skills 条目字段：path 是 Skill 目录（省略时可取 target.dir），name 是 SKILL.md frontmatter 的名称过滤器，id 为可读配置标识；activation 只能是 auto/required，默认 auto。auto 表示可被模型自然发现，**不保证调用**；required 表示执行后必须观测到成功的 skill(name) 调用，否则本次执行失败，不是绕过模型自动执行 Skill 内容。

额外 plugins 条目可为固定版本包字符串，或含 id、package/source、entry、options 的对象；source 为本地目录/入口路径，entry 相对 source。包必须固定版本，例如 pkg@1.2.3；当前代码只做有限字符串检查，不把 @latest/@* 或不固定范围作为可复现实验配置。

MCP 完整定义只放在实际 opencode.json 的 mcp 节点，按服务器名配置 type/local command 或 remote url、enabled 等引擎参数。可选的顶层 experiments 仅覆盖已定义服务器的 enabled，不复制 URL/command，不创建 knowledge 包装。MCP enabled 是布尔值，知识库对照保留同一 Agent，仅改变声明的 MCP 开关；without_enable 不控制 MCP。预检可记录配置，不等于已建立连接或答案确实使用知识。

### 2.7 verification 通用字段与结果引用

| 字段 | 类型 | 默认/规则 |
|---|---|---|
| type | 注册名称 | 必填；完整内置值见2.1 |
| id | string | 省略时取 type；同一层流程中唯一，满足任务 id 的标识规则。相同 type 使用多次必须显式区分 id |
| depends_on | array<string> | 默认空；引用同级 id，禁止不存在节点和环。前置状态必须 completed 才继续，不代表前置业务指标全部通过 |
| requires_execution | boolean | 默认 true；Agent 未完成时不评估。失败分析类流程可显式设 false，自行处理部分工程 |
| resources | array<string> | 默认空；使用 Workflow 默认 requirements 时生效。UITest/CloudTest 自己声明资源，不自动叠加这个数组 |
| timeout | integer | **没有统一默认**；具体流程决定含义/默认值，不能只在通用解析器中设一个值覆盖全部流程 |

id 是结果命名空间：例如 id=ui 的结果写入 verification/ui/，评分 source=ui.metrics.pass_rate；type=UITest 才决定使用哪个验证器。id、dimension、命令文件名都不参与 type 的注册映射。

验证结果结构为 verifier_id、status、metrics、dimensions、findings、evidence、error、version。当前内置流程主要返回 completed、failed、unavailable、skipped；评分读取器也把 error 状态当不可用。业务断言失败可以有 completed+低通过率，或者 failed+可用指标，不能把这两种情况误当成工具缺失。结果状态是本框架约定，AGC 远端状态字符串另由云协议解释。

补充阶段状态：当前 ExecutionResult 使用 completed、failed、timed_out、error、interrupted；ScoreResult 使用 scored、unavailable。它们是输出协议值，不是 task.yaml 中应填写的验证器/评分器类型。verification 没有通用 enabled 开关，不能用 enabled=false 假定某流程被禁用。

#### 2.7.1 UITest

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

#### 2.7.2 CloudTest

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

#### 2.7.3 whiteboxeval 和 LLM_judge

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

#### 2.7.4 LibraryAPICount

source_paths/target_paths 是非空字符串数组，分别相对源工程和目标工程；source_languages/target_languages 是非空数组，元素完整枚举为 dart、typescript、javascript、java、kotlin。ETS 兼容语法使用 typescript；**不接受 arkts/ets 语言别名**。

未填范围时使用自动选取规则；转换前由 capture_input 固定 input-evidence.json。输出 count_match、total_match、source_total、target_total、total_delta、count_consistency；分类为 types/callables/properties。计分通常读取 count_consistency 后乘 100。数量指标不验证签名对应、功能等价或设备表现。

#### 2.7.5 LibraryTests 和 LibraryAPICompatibility

LibraryTests 参数：build_command 和 test_command 是必需的非空字符串参数数组；timeout 默认每条命令 600 秒；tests_destination 默认 evaluation-tests；junit_path 相对评估工程；exit_code_is_test_result 默认不启用，仅显式 true 时将整条命令视作一个通过率指标。

这些参数可来自用例 verification.<id>，其次 verification.<type>，或 expected.tests 中 verification.yaml，最后由当前任务条目覆盖。输出 build_passed、all_tests_passed、pass_rate；提供 JUnit 时还输出 tests_run、passes。构建失败保留失败指标，无报告不能假造逐项测试通过率。

LibraryAPICompatibility 读取 expected.api_mapping 的 YAML：顶层 apis 数组，每条包含 source（说明）、target（目标符号）、可选 file、required_symbols、weight。weight 默认 1 且必须大于 0；file 相对目标工程；required_symbols 省略时使用 target。输出 coverage，是目标符号文本覆盖率，不是完整 API 语义等价证明。

#### 2.7.6 ExactMatch、ToolUsage、Command、AGCDetection

| 流程 | 配置与输出 |
|---|---|
| ExactMatch | 无专用必填参数；需要 case.expected.reference_answers。去掉答案首尾空白后精确匹配任一参考，输出 passed 和 score（100/0） |
| ToolUsage | target_mcp 为服务器名；按已归档工具名的 `目标MCP名_` 前缀统计，输出 configured/enabled/attempted/succeeded。mode 只约定 observe，当前没有其他执行模式，也不验证资料是否被答案引用 |
| Command | command 必填，必须是字符串参数数组；timeout 默认 600 秒。在工程副本运行，退出码 0→metrics.passed=true，其他退出码 false；超时/工具异常→unavailable |
| AGCDetection | command 或 http_url 至少其一；两者都有时先用 command。HTTP 复用第2.9节协议，并将提取出的答案字符串再解析为 JSON，要求 passed 是布尔值；不等于 CloudTest 服务 |

Command 与构建/测试命令仅替换 `${project}`、`${output}`。不支持在这些命令中使用 `${case.question}` 或 `${env:...}`，也不把单个字符串自动送进 shell。

#### 2.7.7 SkillVerifier

| 参数 | 类型 | 默认/规则 |
|---|---|---|
| skill_path | path string | 必填，验证 Skill 目录；不是被测适配 Skill 的自动别名 |
| model | object | **必填**；与 whiteboxeval 可省略不同，当前 schema 要求显式声明 |
| agent_name | string | 默认 build；独立 OpenCode 中可用的 Agent |
| timeout | integer，秒 | 默认 300；该内部审阅会话的 idle_timeout 当前固定 120 |
| result_schema | JSON Schema object | 默认要求对象有 metrics 字段且 metrics 是对象；建议进一步约束具体指标类型/范围 |

在独立评估会话和工程副本中加载目标验证 Skill，并检查成功的 skill 调用。当前最终回答必须是含 metrics 的 JSON，可另含 dimensions/findings；**不会自动读取 Skill 生成的任意 MD/HTML 文件进行评分**。若按文件评分，需要新增报告解析适配或让 Skill 同时返回约定 JSON。

这是完整的可选评估流程，不是所有被测 Skill 的 activation 检查。当前内部会话重写 execution，没有完整继承父任务 enviroment/opencode 覆盖；需要专用 SDK 或特定宿主的评估 Skill，应先补齐环境透传并验证，不能仅凭此类型宣称任意 Skill 均可运行。

#### 2.7.8 Workflow

steps 为 verification 条目数组，或 workflow_path 指向含 steps 的 YAML，至少一种。外部文件的相对路径按该文件目录解析；当前内嵌 steps/metrics 已存在时优先使用已有值。最大嵌套深度 16，循环引用拒绝。

metrics 是“对外指标名→内部流程结果路径”的对象，如 `{score: judge.metrics.score}`；外层评分读取 `组合id.metrics.score`，不直接假定内部 id 是顶层评分命名空间。内部结果保留在 evidence。steps 内可重复使用相同验证器类型，但必须有不同 id。

### 2.8 scoring：规则名、来源和报告维度

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

### 2.9 HTTP 智能问答协议字段

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

### 2.10 report、废弃字段及内部字段

| 字段 | 类型 | 必填/默认 | 行为 |
|---|---|---|---|
| report.output_dir | path string | 必填 | 相对任务文件解析；实际目录下再创建唯一 run_id |
| report.format | string | 默认 html；允许 html/json | 当前 write_task_report 总写 task-report.json 和 index.html，尚未按 json 值禁止生成 HTML；不要将其解释成两套不同报告源 |

不能再使用的字段：runtime_config、execution.runtime、迁移 expected.output_kind/output_project；不要新增 comparison 来代替 without_enable，不将 distribution 与 engine 重复配置。历史 knowledge_agent/host_target/without_process 仅保留未启用模板，不是本地 MCP 评测入口。scoring_preset 暂无自动展开实现；ToolUsage.mode 除观测外无其他行为；Judge.input 选择器不存在。

source、base_dir、active、variant 是生成的内部字段，用户不需要填写，也不能用它们覆盖运行身份。单组任务的 variant 为 with，不代表 MCP 已启用。without_enable=true 自动展开 without、with 两个实验子组；字段不再表示本次只跑关闭组。配置 experiments 后子任务的 variant 为对应实验 ID；experiment 是展开后的运行时字段，不能在 YAML 中直接填写。

### 2.11 最小引用示例

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

## 3. 一次任务怎样跑对照

### 3.1 Skill/Plugin 有无对照

```yaml
plugin_agent:
  execution:
    engine: opencode
    agent_name: hmos-library-adapter-fast
    without_enable: true  # 一次执行 without 和 with，自动比较
    # without_agent_name: build  # Plugin 默认 build，可省略
```

这是活动块片段，不是完整任务。false/省略只跑加载目标的 with；true 先跑不加载目标的 without，再跑加载的 with，**不需要 experiments**。Plugin 的关闭组默认用宿主 build，Skill 默认沿用同一 Agent。agent_name 总是指加载组；公共模型、提示词和判据保持一致，工程与日志分组隔离。

批次生成 index.html、experiments-report.json，子组位于 experiments/without/ 与 experiments/with/，差值位于 comparisons/with/。实际加载看 target_enabled 和能力清单；Plugin Agent 与 build 不同时，结论是完整插件方案相对宿主的效果。旧语义“true只跑关闭组”的报告不能直接作为新双组任务复用。

### 3.2 MCP 有无对照

已实现。入口仍为 `harmonyeval run <task.yaml>`，顶层新增可选字段：

```yaml
experiments:
  - id: without_mcp
    overrides:
      mcp:
        harmonyos_developer_knowledge:
          enabled: false
  - id: with_mcp
    overrides:
      mcp:
        harmonyos_developer_knowledge:
          enabled: true
```

完整三方库配置见 `config/task.library-plugin.mcp.yaml`，基础 MCP 配置为 `config/opencode.library-mcp.json`。两组均加载 target 指定的 hmos-library-adapter-fast、执行同一 Agent，使用当前三方库任务相同的 glm-5.3/Coding Plan 模型；密钥使用环境变量 ZHIPU_API_KEY。原有 API 数量和白盒评分不变，增加 ToolUsage 观测，不把 MCP 未调用自动计为业务失败。

配置契约：

| 字段 | 类型/范围 | 语义 |
|---|---|---|
| experiments | 非空 array，1～100 组，可省略 | 按声明顺序逐组执行；省略且 without_enable=false 时保持单组行为 |
| experiments[].id | 唯一 string，`^[\w.-]{1,160}$`，排除 `.`、`..` | 子运行和产物标识，不是 Agent/MCP 名称；第一组为比较基准 |
| experiments[].overrides | object，仅允许 mcp | 当前不接受模型、Agent、Plugin 等其他覆盖 |
| overrides.mcp | 非空 object | 键为基础 OpenCode 配置中已定义的 MCP 名称，各组必须显式配置同一组名称 |
| overrides.mcp.<server>.enabled | boolean：true/false | 每个服务器唯一可覆盖字段；不接受字符串或 URL/command 等其他字段 |

支持全部 `engine: opencode` 的目标，包含 skills、plugin_agent、harmonybot_agent、opencode_agent；HTTP 后端不接受 MCP experiments。基础服务器必须有 type: local/remote 及对应 command/url，缺失会在任何组开始生成前失败。基础定义可以来自宿主配置，或由 config_path 合并提供；框架只改变系统临时目录中的运行副本，不回写用户配置。

产物为 `report.output_dir/<batch_run_id>/experiments/<id>/` 下各自的 task-report.json、index.html 和 EvalScope 结果，用例位于其 `variants/<id>/round-XX/cases/<case_id>/base/`。批次根目录生成脱敏 task.resolved.yaml、experiments-report.json、index.html，后续组与第一组的对比放在 `comparisons/<后续组ID>/`，差值为后续组减第一组。

比较严格保留模型、Agent、without_enable、预算、用例、能力源、引擎版本、验证/评分和其他 MCP 配置；只对 experiments 声明的服务器忽略 enabled。除准备配置的指纹外，还比较 OpenCode 实际加载配置的指纹，并核验每组开关与声明一致。公共来源在组间发生变化会拒绝比较，不将全部 MCP enabled 一并排除。该规则适用于 LibraryMigration 等场景，不要求伪装成 KnowledgeEval。原有无 experiments 的单组及 KnowledgeEval 对照继续兼容。

失败组保留报告并继续后续组；执行/评分不完整或比较不可用使命令退出码为 1。有效业务零分仍是成功完成的评分。缺失证据不补零，对比不可用时在汇总中保留诊断。`plan/--check` 展示所有组的真实装载计划；`verify/rescore/compare` 指定具体 `experiments/<id>/` 子报告，复评时根据报告 ID 和覆盖配置匹配当前 YAML，变更开关不能复用旧结果。

MCP 配置和调用证据分开记录：ToolUsage 当前返回 configured、enabled、attempted、succeeded，不判断答案是否引用返回资料，也不能用 configured 代替连接成功。自然调用和强制调用是不同实验条件，需要分别命名。有无 MCP 的运行采用相同中性问题，避免额外提示影响对照。

原模板的 knowledge_agent、host_target 和 without_process 暂保留为历史预留字段，不增加新的执行入口。本地 OpenCode/HarmonyBot 的 MCP 评测不使用这层包装，也不需要删除知识文件的脚本。若任务选择预留的 knowledge_agent 类型，预检应提示改用实际运行的 harmonybot_agent 或 opencode_agent。

MCP experiments 不能与 without_enable=true 同时启用。两者是不同对照：前者固定被测 Skill/Plugin/Agent，只改 MCP；后者比较加载和不加载目标 Skill/Plugin。

## 4. 选择场景配置

以下覆盖18份源任务：10份当前任务、8份通用模板。历史文件名 without.yaml 在 without_enable=true 时已表示自动双组，无需再重复执行 with.yaml。默认 task.yaml 的模型与独立任务可能不同，不能把它们直接当作只改一个开关的对照。

| 示例位置 | YAML 源文件 | 用途 |
|---|---|---|
| [5.1](#51-默认任务configtaskyaml-的生效配置) | [config/task.yaml](../config/task.yaml) | 默认实际任务，只展示活动 plugin_agent 块 |
| [5.2](#52-一多适配harmonybot-中指定一多-agent) | [config/task.multidev.yaml](../config/task.multidev.yaml) | 本机一多任务，直接评 Agent |
| [5.3](#53-三方库转鸿蒙库opencode-指定-skill) | [config/examples/task.library-skill.yaml](../config/examples/task.library-skill.yaml) | 三方库 Skill 通用模板，自动双组对照 |
| [5.4](#54-三方库转鸿蒙库opencode-装载指定-plugin) | [config/task.library-plugin.with.yaml](../config/task.library-plugin.with.yaml) | 本机三方库 Plugin 加载组 |
| [5.5](#55-安卓应用转鸿蒙harmonybot-中指定-d2h-agent) | [config/examples/task.android-migration.yaml](../config/examples/task.android-migration.yaml) | Android 迁移通用模板 |
| [5.6](#56-标准-opencode直接指定一个-agent) | [config/examples/task.opencode-agent.yaml](../config/examples/task.opencode-agent.yaml) | 指定 OpenCode Agent 通用模板 |
| [5.7](#57-harmonybot-的-d2h-agent通过-opencodejson-配置有无-mcp) | [config/examples/task.mcp-harmonybot.yaml](../config/examples/task.mcp-harmonybot.yaml) | HarmonyBot 有无 MCP 通用模板 |
| [5.8](#58-标准-opencode通过-opencodejson-配置有无-mcp) | [config/examples/task.mcp-opencode.yaml](../config/examples/task.mcp-opencode.yaml) | 独立 OpenCode 有无 MCP 通用模板 |
| [5.9](#59-智能问答knowledge-配置请求-url-后端的-agent) | [config/examples/task.knowledge-http.yaml](../config/examples/task.knowledge-http.yaml) | HTTP 智能问答通用模板 |
| [5.10](#510-三方库转换自动-plugin-有无对照) | [config/task.library-plugin.without.yaml](../config/task.library-plugin.without.yaml) | 三方库转换：自动 Plugin 有无对照 |
| [5.11](#511-三方库转换固定-plugin比较有无-mcp) | [config/task.library-plugin.mcp.yaml](../config/task.library-plugin.mcp.yaml) | 三方库转换：固定 Plugin，比较有无 MCP |
| [5.12](#512-api-升级加载适配-skill使用-uitest-与云测试验收) | [config/task.api-upgrade.with.yaml](../config/task.api-upgrade.with.yaml) | API 升级：加载适配 Skill，使用 UITest 与云测试验收 |
| [5.13](#513-api-升级自动-skill-有无对照) | [config/task.api-upgrade.without.yaml](../config/task.api-upgrade.without.yaml) | API 升级：自动 Skill 有无对照 |
| [5.14](#514-共享-json-问答独立-opencode-开启华为知识-mcp) | [config/qa/huawei-mcp/with/task.yaml](../config/qa/huawei-mcp/with/task.yaml) | 共享 JSON 问答：独立 OpenCode 开启华为知识 MCP |
| [5.15](#515-共享-json-问答独立-opencode-关闭华为知识-mcp) | [config/qa/huawei-mcp/without/task.yaml](../config/qa/huawei-mcp/without/task.yaml) | 共享 JSON 问答：独立 OpenCode 关闭华为知识 MCP |
| [5.16](#516-共享-json-问答http-智能客服本地桩) | [config/qa/customer-service/task.yaml](../config/qa/customer-service/task.yaml) | 共享 JSON 问答：HTTP 智能客服本地桩 |
| [5.17](#517-三方库转换通用-plugin-模板) | [config/examples/task.library-plugin.yaml](../config/examples/task.library-plugin.yaml) | 三方库转换：通用 Plugin 模板 |
| [5.18](#518-一多适配通用模板) | [config/examples/task.multidev.yaml](../config/examples/task.multidev.yaml) | 一多适配：通用模板 |

## 5. 完整 YAML 示例

下面保留18份完整快照。config/task.yaml 只展示生效的 plugin_agent 块，其他源文件完整展示；快照按解析值排版，密钥已替换为环境变量名，生成参数保持原值。本机路径、插件、模型、设备、rubric 和服务地址需要替换成目标环境，模板不是运行成功的证明。

### 5.1 默认任务：`config/task.yaml` 的生效配置

该文件保留了多场景模板，下面只展开实际参与执行的字段；除凭据脱敏外，配置值与源文件一致，其余块不展开、不启用。插件入口由 `target.dir` 下的 package.json.main 确定，不重复配置 execution.opencode.plugins。

<!-- config-snapshot: config/task.yaml active -->
```yaml
schema_version: 2
scenario: LibraryMigration
id: thirdcase-library-plugin
description: 评测hmos-library-adapter-fast转换thirdcase库的效果
dataset:
  type: library-migration
  dir: /Users/mayism/thirdcase
  layout: repositories
  instruction: 请将当前第三方库适配到HarmonyOS，在当前工程内完成实现。阅读README和源码，保持原有公开API及已有平台行为，识别并处理依赖的鸿蒙兼容性；对于无法等价实现的平台能力，明确说明限制与替代方案，不得虚构API或用空实现冒充支持。请提供使用说明和构建、验证结果。
target:
  type: plugin_agent
  dir: /Users/mayism/.config/opencode/plugins/hmos-library-adapter-fast
plugin_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: hmos-library-adapter-fast
    without_enable: false
    timeout: 3600
    idle_timeout: 3600
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
    model:
      api_type: openai_api
      name: glm-4.7
      max_tokens: 8192
      temperature: 0.7
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
  verification:
  - id: api
    type: LibraryAPICount
  - id: code
    type: whiteboxeval
    rubric_path: ./rubrics/library-migration.md
  scoring:
  - dimension: api_count_consistency
    type: ImmediateValue
    source: api.metrics.count_consistency
    scale: 100
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
  report:
    output_dir: ../output/harmony-eval/thirdcase-plugin
    format: html
```

三方库当前读取 `/Users/mayism/thirdcase` 的原始仓库，通过 dataset.instruction 提供转换要求。初版验收是 API 数量一致率与白盒 L3，不要求预先提供 API 映射和功能测试命令；数量一致不等于功能适配成功。


### 5.2 一多适配：HarmonyBot 中指定一多 Agent

配置来源：`config/task.multidev.yaml`；相对路径以该文件所在目录解析。

数据集继续采用现有 base/PROMPT.md/metadata.json/test_patch.patch 等格式；本机读取 /Users/mayism/cases。该 YAML 已写入原 JSON 的工具链及 Pura 90 Pro、Mate X7、MatePad Pro 13 三台设备，使用独立插件 YAML 的 glm-5.3 模型，并完整展开已确认的 L1/L2/L3 评分；通用模板另见 5.18。生成时检查到一个有效 CaseBookRead 用例，metadata.case_id 为 bookread-template-derive-base；这属于配置预检结果，不代表已完成设备回归。

<!-- config-snapshot: config/task.multidev.yaml -->
```yaml
schema_version: 2
scenario: MultiDev
id: multidev-harmonybot
description: 评测 HarmonyBot 一多 Agent 的适配效果
dataset:
  type: swe-bench-hm-multi-dev
  dir: /Users/mayism/cases
target:
  type: harmonybot_agent
  dir: /Users/mayism/.vscode/extensions
harmonybot_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: harmonyos-multi-device
    timeout: 3600
    idle_timeout: 3600
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
      java_home: /Applications/DevEco-Studio.app/Contents/jbr/Contents/Home
      sdk_home: /Applications/DevEco-Studio.app/Contents/sdk
    model:
      api_type: openai_api
      name: glm-5.3
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
    concurrency: 3
  verification:
  - id: ui
    type: UITest
    deveco_home: /Applications/DevEco-Studio.app/Contents
    emulator_deployed_dir: /Users/mayism/.Huawei/Emulator/deployed
    devices:
    - id: phone
      profile: Pura 90 Pro
      target: 127.0.0.1:15001
      hdc_port: 15001
      start_emulator: true
    - id: foldable
      profile: Mate X7
      target: 127.0.0.1:15005
      hdc_port: 15005
      start_emulator: true
    - id: tablet
      profile: MatePad Pro 13
      target: 127.0.0.1:15008
      hdc_port: 15008
      start_emulator: true
    timeout: 7200
    paths:
      hvigorw: /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw
      ohpm: /Applications/DevEco-Studio.app/Contents/tools/ohpm/bin/ohpm
      hdc: /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc
      emulatorBin: /Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator
  - id: code
    type: whiteboxeval
  scoring:
  - dimension: L1
    type: BooleanScoring
    all:
    - source: ui.metrics.build_passed
      equals: true
    - source: ui.metrics.all_tests_passed
      equals: true
    pass_score: 100
    fail_score: 0
  - dimension: L2
    type: WeightedSummation
    mode: deduction
    base_score: 100
    components:
    - name: UX
      source: ui.metrics.pass_rate
      range:
      - 0
      - 1
      weight: 0.5
    - name: Whitebox
      source: code.dimensions
      reducer: proportional_deduction
      cap_source: code.metrics.total_score
      weight: 0.5
    missing: unavailable
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
  report:
    output_dir: ../output/harmony-eval/multidev-harmonybot
    format: html
```

### 5.3 三方库转鸿蒙库：OpenCode 指定 Skill

配置来源：`config/examples/task.library-skill.yaml`；相对路径以该文件所在目录解析。

target.dir 下按 SKILL.md 声明的 name 选择 library-conversion。本例 without_enable 为 true，只运行不加载目标 Skill 的基线；设为 false 后加载该 Skill。两次均使用同一 build Agent。

<!-- config-snapshot: config/examples/task.library-skill.yaml -->
```yaml
schema_version: 2
scenario: LibraryMigration
id: library-conversion-skill
description: 不加载目标三方库转换 Skill 的基线评测
dataset:
  type: library-migration
  dir: ../../datasets/libraries
target:
  type: skills
  dir: ../../capabilities/library-skills
skills:
  rounds: 1
  execution:
    engine: opencode
    agent_name: build
    timeout: 1800
    idle_timeout: 300
    without_enable: true
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
    opencode:
      binary: /path/to/opencode
      skills:
      - id: library-conversion
        name: library-conversion
        activation: auto
  verification:
  - id: api
    type: LibraryAPICount
  - id: code
    type: whiteboxeval
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
    rubric_path: ./rubrics/library-migration.yaml
  scoring:
  - dimension: api_count_consistency
    type: ImmediateValue
    source: api.metrics.count_consistency
    scale: 100
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
  report:
    output_dir: ../../outputs/library-conversion-skill
    format: html
```

### 5.4 三方库转鸿蒙库：OpenCode 装载指定 Plugin

配置来源：`config/task.library-plugin.with.yaml`；相对路径以该文件所在目录解析。

本例为实际加载组：without_enable: false，执行插件注册的 hmos-library-adapter-fast。目标插件已配置在独立 OpenCode 的 /Users/mayism/.config/opencode/plugins/hmos-library-adapter-fast。一键双组对照配置见 5.10；without_enable=true 自动生成 baseline build 和加载组 Agent，两组均用 glm-5.3。target.dir 保持一致以标识关闭的被测对象。

<!-- config-snapshot: config/task.library-plugin.with.yaml -->
```yaml
schema_version: 2
scenario: LibraryMigration
id: thirdcase-library-plugin
description: 评测hmos-library-adapter-fast转换thirdcase库的效果
dataset:
  type: library-migration
  dir: /Users/mayism/thirdcase
  layout: repositories
  instruction: 请将当前第三方库适配到HarmonyOS，在当前工程内完成实现。阅读README和源码，保持原有公开API及已有平台行为，识别并处理依赖的鸿蒙兼容性；对于无法等价实现的平台能力，明确说明限制与替代方案，不得虚构API或用空实现冒充支持。请提供使用说明和构建、验证结果。
target:
  type: plugin_agent
  dir: /Users/mayism/.config/opencode/plugins/hmos-library-adapter-fast
plugin_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: hmos-library-adapter-fast
    without_enable: false
    timeout: 3600
    idle_timeout: 3600
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
    model:
      api_type: openai_api
      name: glm-5.3
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
  verification:
  - id: api
    type: LibraryAPICount
  - id: code
    type: whiteboxeval
    rubric_path: ./rubrics/library-migration.md
  scoring:
  - dimension: api_count_consistency
    type: ImmediateValue
    source: api.metrics.count_consistency
    scale: 100
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
  report:
    output_dir: ../output/harmony-eval/thirdcase-plugin
    format: html
```

如果直接评 HarmonyBot 内置的三方库转换 Agent，则使用 `target.type: harmonybot_agent`、`agent_name: hmos-library-adapter-fast`，并将上例验证和评分配置放到 harmonybot_agent 块；数据集保持 library-migration。

### 5.5 安卓应用转鸿蒙：HarmonyBot 中指定 d2h Agent

配置来源：`config/examples/task.android-migration.yaml`；相对路径以该文件所在目录解析。

输入为安卓应用工程。UITest 评估流程针对 Agent 生成的鸿蒙工程，内部完成编译、安装和测试，测试与验收预期由各 case 提供。verification 仅配置评估流程，不单独配置编译步骤。

<!-- config-snapshot: config/examples/task.android-migration.yaml -->
```yaml
schema_version: 2
scenario: AndroidMigration
id: android-migration-harmonybot
description: 评测 HarmonyBot 安卓转鸿蒙 Agent
dataset:
  type: android-migration
  dir: ../../datasets/android-apps
target:
  type: harmonybot_agent
  dir: /path/to/vscode/extensions
harmonybot_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: d2h
    timeout: 3600
    idle_timeout: 300
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
  verification:
  - id: ui
    type: UITest
    deveco_home: /Applications/DevEco-Studio.app/Contents
    emulator_deployed_dir: /path/to/emulators
    devices:
    - id: phone
      profile: Pura 90 Pro
      target: 127.0.0.1:15001
      hdc_port: 15001
      start_emulator: true
  - id: code
    type: whiteboxeval
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
    rubric_path: ./rubrics/android-migration.yaml
  scoring:
  - dimension: L1
    type: BooleanScoring
    all:
    - source: ui.metrics.build_passed
      equals: true
    - source: ui.metrics.all_tests_passed
      equals: true
    pass_score: 100
    fail_score: 0
  - dimension: L2
    type: ImmediateValue
    source: ui.metrics.pass_rate
    scale: 100
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
  report:
    output_dir: ../../outputs/android-migration-harmonybot
    format: html
```

### 5.6 标准 OpenCode：直接指定一个 Agent

配置来源：`config/examples/task.opencode-agent.yaml`；相对路径以该文件所在目录解析。

`opencode_agent` 为正式目标类型。`qa-agent` 必须由指定 config_path 的运行配置注册；该配置中的能力也写入有效能力清单。更换 agent_name 即可评另一个已注册 Agent。

<!-- config-snapshot: config/examples/task.opencode-agent.yaml -->
```yaml
schema_version: 2
scenario: QuestionAnswering
id: opencode-selected-agent
description: 使用文本问题评测 OpenCode 中指定的 Agent
dataset:
  type: text-qa
  dir: ../../datasets/qa
target:
  type: opencode_agent
opencode_agent:
  rounds: 1
  execution:
    engine: opencode
    agent_name: qa-agent
    timeout: 120
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
    opencode:
      binary: /path/to/opencode
      config_path: ./runtime/opencode-agents.json
  verification:
  - id: qa
    type: LLM_judge
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
    prompt_path: ./rubrics/answer-quality.md
  scoring:
  - dimension: answer_quality
    type: ImmediateValue
    source: qa.metrics.score
  report:
    output_dir: ../../outputs/opencode-selected-agent
    format: html
```

如该 Agent 用于工程任务，则替换 dataset，并选择相应工程验证器；执行器仍使用相同的 OpenCode 适配。

### 5.7 HarmonyBot 的 d2h Agent：通过 opencode.json 配置有无 MCP

配置来源：`config/examples/task.mcp-harmonybot.yaml`；相对路径以该文件所在目录解析。

这仍然是 harmonybot_agent 任务，agent_name 为 d2h。知识库是 HarmonyBot 的 OpenCode 配置中的 MCP，YAML 仅指定要加载的配置文件，不使用 knowledge_agent 或 host_target 包装。

<!-- config-snapshot: config/examples/task.mcp-harmonybot.yaml -->
```yaml
schema_version: 2
scenario: KnowledgeEval
id: harmonybot-d2h-mcp
description: 比较同一 HarmonyBot d2h Agent 在有无 MCP 时的答案质量
dataset:
  type: text-qa
  dir: ../../datasets/knowledge-qa
target:
  type: harmonybot_agent
  dir: /path/to/vscode/extensions
harmonybot_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: d2h
    timeout: 120
    opencode:
      config_path: ./opencode/harmonybot.json
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
  verification:
  - id: qa
    type: LLM_judge
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
    prompt_path: ./rubrics/knowledge-answer-quality.md
  - id: usage
    type: ToolUsage
    target_mcp: developer_knowledge
    mode: observe
  scoring:
  - dimension: answer_quality
    type: ImmediateValue
    source: qa.metrics.score
  report:
    output_dir: ../../outputs/harmonybot-d2h-mcp
    format: html
```

与本例 config_path 对应的 `config/examples/opencode/harmonybot.json` 需自行准备，第一次运行时启用 MCP：

```json
{
  "mcp": {
    "developer_knowledge": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "enabled": true
    }
  }
}
```

第二次运行使用相同 YAML 和相同 JSON 文件，只将目标 MCP 的 enabled 改为 false：

```json
{
  "mcp": {
    "developer_knowledge": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "enabled": false
    }
  }
}
```

分别运行两次，第二次只修改同一 OpenCode 配置文件中的 MCP enabled；YAML、d2h Agent、模型、问题、验证和评分保持相同。这里不配置 without_enable，也不关闭 HarmonyBot Plugin。

config_path 是可选的。已经在 HarmonyBot 实际生效的 opencode.json 中配置 MCP 时，可以省略该字段，直接使用并记录该有效配置；两次只修改目标 MCP 的 enabled 并重新加载。框架保存两次最终生效的配置快照，以复核知识库状态。

这里的 JSON 是对 HarmonyBot 生效配置的补充：框架合并到实际 Bundle 配置的运行副本，保留 d2h 的 Plugin、Agent 定义与其他能力。如果直接复用已有完整的 HarmonyBot opencode.json，也按相同方式读取并记录最终配置；仅修改未生效的源码配置不能作为已经切换的证据。

若评真实安卓应用迁移，将 dataset.type 换成 android-migration，并使用 5.5 的工程验证与评分；MCP 仍然只在 OpenCode 配置中切换。

### 5.8 标准 OpenCode：通过 opencode.json 配置有无 MCP

配置来源：`config/examples/task.mcp-opencode.yaml`；相对路径以该文件所在目录解析。

本例是普通 opencode_agent 任务，由标准 OpenCode 的同一个 build Agent 回答文本问题。YAML 只指定引擎、Agent 和它加载的 opencode.json，不配置知识库包装、host_target、MCP 定义或 without_enable。scenario: KnowledgeEval 仅标记评测目的，不改变执行入口。ToolUsage 是可选的调用观测步骤，不控制 MCP。

<!-- config-snapshot: config/examples/task.mcp-opencode.yaml -->
```yaml
schema_version: 2
scenario: KnowledgeEval
id: opencode-agent-mcp
description: 比较同一 OpenCode Agent 在有无 MCP 时的答案质量
dataset:
  type: text-qa
  dir: ../../datasets/knowledge-qa
target:
  type: opencode_agent
opencode_agent:
  rounds: 1
  execution:
    engine: opencode
    agent_name: build
    timeout: 120
    opencode:
      binary: /path/to/opencode
      config_path: ./opencode/opencode.json
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
  verification:
  - id: qa
    type: LLM_judge
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
    prompt_path: ./rubrics/knowledge-answer-quality.md
  - id: usage
    type: ToolUsage
    target_mcp: developer_knowledge
    mode: observe
  scoring:
  - dimension: answer_quality
    type: ImmediateValue
    source: qa.metrics.score
  report:
    output_dir: ../../outputs/opencode-agent-mcp
    format: html
```

与本例 config_path 对应的 `config/examples/opencode/opencode.json` 需自行准备，第一次运行时启用 MCP：

```json
{
  "mcp": {
    "developer_knowledge": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "enabled": true
    }
  }
}
```

第二次使用相同 YAML、相同 opencode.json，只将目标 MCP 的 enabled 改为 false：

```json
{
  "mcp": {
    "developer_knowledge": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "enabled": false
    }
  }
}
```

两次运行的 YAML 完全相同，无需额外配置文件或新目标类型；MCP 状态完全由这个 opencode.json 决定。config_path 仍为可选项，省略时使用当前 OpenCode 的生效配置。若指定自定义 Agent，两次运行应保留相同定义。当前 KnowledgeEval 对照计算宿主指纹时移除所有 MCP enabled 值；它不能证明只改了目标 MCP 一个开关，仍需人工检查两份配置差异。

### 5.9 智能问答：knowledge 配置请求 URL 后端的 Agent

配置来源：`config/examples/task.knowledge-http.yaml`；相对路径以该文件所在目录解析。

knowledge 表示智能问答，使用 HTTP 请求后端 Agent，与 5.7/5.8 中配置了 MCP 的本地 Agent 任务分别配置。本例为同步 JSON 协议，POST 问题后从 data.answer 取答案。后端生成模型由服务管理；verification.model 单独声明裁判模型。

<!-- config-snapshot: config/examples/task.knowledge-http.yaml -->
```yaml
schema_version: 2
scenario: QuestionAnswering
id: knowledge-http-qa
description: 评测 HTTP 后端 Agent 的问答质量
dataset:
  type: text-qa
  dir: ../../datasets/qa
target:
  type: knowledge
knowledge:
  rounds: 1
  execution:
    engine: http
    http_url: https://example.com/agent/answer
    method: POST
    timeout: 120
    request:
      headers:
        Authorization: Bearer ${env:AGENT_TOKEN}
      json:
        question: ${case.question}
    response:
      protocol: json
      answer_path: data.answer
      session_id_path: data.session_id
  verification:
  - id: qa
    type: LLM_judge
    prompt_path: ./rubrics/answer-quality.md
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
  scoring:
  - dimension: answer_quality
    type: ImmediateValue
    source: qa.metrics.score
  report:
    output_dir: ../../outputs/knowledge-http-qa
    format: html
```

如评测通用 HTTP Agent，可同时将上例的 target.type 和顶层配置块名改为 http_agent，其他请求/响应与评分配置不变；knowledge 不会被当作本地 Agent 的 MCP 配置块。

HTTP 的 JSON、SSE、异步提交/轮询分别由协议适配器实现。`${...}` 仅允许 case.question、case.case_id、env:变量名和轮询 job_id 等已实现替换项。每样本发起独立请求；response.session_id_path 仅提取后端返回的会话 ID，当前没有跨样本多轮会话组调度，不能配置后就声称已支持连续多轮对话。

### 5.10 三方库转换：自动 Plugin 有无对照

配置来源：[config/task.library-plugin.without.yaml](../config/task.library-plugin.without.yaml)；所有相对路径以该源 YAML 所在目录解析。

历史 without 文件名保留；该文件的 without_enable=true 现在表示一次自动执行两组：without 不加载目标插件并使用 build，with 加载插件并使用 hmos-library-adapter-fast。两组均用相同 glm-5.3 和判据，自动生成差值；无需再单独运行 5.4。Agent ID 的差异表示完整插件能力方案的对照。

<!-- config-snapshot: config/task.library-plugin.without.yaml -->
```yaml
schema_version: 2
scenario: LibraryMigration
id: thirdcase-library-plugin
description: 评测hmos-library-adapter-fast转换thirdcase库的效果
dataset:
  type: library-migration
  dir: /Users/mayism/thirdcase
  layout: repositories
  instruction: 请将当前第三方库适配到HarmonyOS，在当前工程内完成实现。阅读README和源码，保持原有公开API及已有平台行为，识别并处理依赖的鸿蒙兼容性；对于无法等价实现的平台能力，明确说明限制与替代方案，不得虚构API或用空实现冒充支持。请提供使用说明和构建、验证结果。
target:
  type: plugin_agent
  dir: /Users/mayism/.config/opencode/plugins/hmos-library-adapter-fast
plugin_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: hmos-library-adapter-fast
    without_enable: true
    timeout: 3600
    idle_timeout: 3600
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
    model:
      api_type: openai_api
      name: glm-5.3
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
  verification:
  - id: api
    type: LibraryAPICount
  - id: code
    type: whiteboxeval
    rubric_path: ./rubrics/library-migration.md
  scoring:
  - dimension: api_count_consistency
    type: ImmediateValue
    source: api.metrics.count_consistency
    scale: 100
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
  report:
    output_dir: ../output/harmony-eval/thirdcase-plugin
    format: html
```

### 5.11 三方库转换：固定 Plugin，比较有无 MCP

配置来源：[config/task.library-plugin.mcp.yaml](../config/task.library-plugin.mcp.yaml)；所有相对路径以该源 YAML 所在目录解析。

两组均加载 hmos-library-adapter-fast，保持 Agent、模型、提示词及验收规则一致。基础 MCP 定义来自 [config/opencode.library-mcp.json](../config/opencode.library-mcp.json)，experiments 仅覆盖 harmonyos_developer_knowledge.enabled，按 without_mcp、with_mcp 顺序执行并比较；ToolUsage 观测调用，不把未调用自动记为转换失败。

<!-- config-snapshot: config/task.library-plugin.mcp.yaml -->
```yaml
schema_version: 2
scenario: LibraryMigration
id: thirdcase-library-plugin-mcp
description: 三方库插件保持加载，仅比较目标 MCP 启用和关闭的转换效果。
dataset:
  type: library-migration
  dir: /Users/mayism/thirdcase
  layout: repositories
  instruction: 请将当前第三方库适配到HarmonyOS，在当前工程内完成实现。阅读README和源码，保持原有公开API及已有平台行为，识别并处理依赖的鸿蒙兼容性；对于无法等价实现的平台能力，明确说明限制与替代方案，不得虚构API或用空实现冒充支持。请提供使用说明和构建、验证结果。
target:
  type: plugin_agent
  dir: /Users/mayism/.config/opencode/plugins/hmos-library-adapter-fast
plugin_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: hmos-library-adapter-fast
    without_enable: false
    timeout: 3600
    idle_timeout: 3600
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
    model:
      api_type: openai_api
      name: glm-5.3
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
    opencode:
      config_path: ./opencode.library-mcp.json
  verification:
  - id: api
    type: LibraryAPICount
  - id: code
    type: whiteboxeval
    rubric_path: ./rubrics/library-migration.md
  - id: mcp_usage
    type: ToolUsage
    target_mcp: harmonyos_developer_knowledge
  scoring:
  - dimension: api_count_consistency
    type: ImmediateValue
    source: api.metrics.count_consistency
    scale: 100
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
  report:
    output_dir: ../output/harmony-eval/thirdcase-plugin-mcp
    format: html
experiments:
- id: without_mcp
  overrides:
    mcp:
      harmonyos_developer_knowledge:
        enabled: false
- id: with_mcp
  overrides:
    mcp:
      harmonyos_developer_knowledge:
        enabled: true
```

```sh
harmonyeval run ./config/task.library-plugin.mcp.yaml --check
harmonyeval run ./config/task.library-plugin.mcp.yaml
```

### 5.12 API 升级：加载适配 Skill，使用 UITest 与云测试验收

配置来源：[config/task.api-upgrade.with.yaml](../config/task.api-upgrade.with.yaml)；所有相对路径以该源 YAML 所在目录解析。

待测目录为 /Users/mayism/apiupgrade，使用 swe-bench-hm-multi-dev 解析现有 base/PROMPT/metadata/patch 布局。固定读取各用例 PROMPT.md 原文，不追加组别提示；加载 harmonyos-api-upgrade-adapter Skill，由 build Agent 执行。verification 明确包含 UITest 和 CloudTest，scoring 分别读取对应指标。签名材料路径仍需在本机存在，云测试还需实际 AGC 认证和资源。

源 YAML 注释记录：base 已恢复为修复前的 5.1.0(12)，PROMPT 要求升级到 26.1.0(26) 并保持应用行为；现有 UITest 按 target 检查对应行为，不能仅凭测试通过就认定旧行为保持不变，后者仍需专门断言。Skill 默认 activation=auto，加载不保证被实际调用，应检查 Agent 工具轨迹。云测试当前使用类别 24，认证取 config/agc-cookie.txt 或 AGC_AUTH_INFO，另需 AGC_TEAM_ID、AGC_PROJECT_ID；--check 不验证远端认证、配额、签名或设备真实可用性。

<!-- config-snapshot: config/task.api-upgrade.with.yaml -->
```yaml
schema_version: 2
scenario: APIUpgrade
id: api-upgrade-skill
description: 比较独立 OpenCode 加载/不加载 harmonyos-api-upgrade-adapter 的 API 升级任务执行结果
dataset:
  type: swe-bench-hm-multi-dev
  dir: /Users/mayism/apiupgrade
target:
  type: skills
  dir: /Users/mayism/Downloads/harmonyos-api-upgrade-adapter
skills:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: build
    without_enable: false
    timeout: 3600
    idle_timeout: 3600
    concurrency: 1
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
      sdk_home: /Applications/DevEco-Studio.app/Contents/sdk
      java_home: /Applications/DevEco-Studio.app/Contents/jbr/Contents/Home
    model:
      api_type: openai_api
      name: glm-5.3
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
  verification:
  - id: ui
    type: UITest
    deveco_home: /Applications/DevEco-Studio.app/Contents
    emulator_deployed_dir: /Users/mayism/.Huawei/Emulator/deployed
    timeout: 7200
    paths:
      hvigorw: /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw
      ohpm: /Applications/DevEco-Studio.app/Contents/tools/ohpm/bin/ohpm
      hdc: /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc
      emulatorBin: /Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator
    devices:
    - id: phone
      profile: Pura 90 Pro
      target: 127.0.0.1:15001
      hdc_port: 15001
      start_emulator: true
  - id: cloud
    type: CloudTest
    testCategories:
    - category: 24
      timeSpan: 60
    buildTimeoutSec: 1800
    taskTimeoutSec: 7200
    pollIntervalSec: 60
    product: default
    buildMode: release
    signingConfigs:
    - name: default
      type: HarmonyOS
      material:
        storeFile: /Users/mayism/code/multi-device-autorun/config/signing/test.p12
        profile: /Users/mayism/code/multi-device-autorun/config/signing/test.p7b
        certpath: /Users/mayism/code/multi-device-autorun/config/signing/test.cer
  scoring:
  - dimension: uitest
    type: BooleanScoring
    all:
    - source: ui.metrics.build_passed
      equals: true
    - source: ui.metrics.all_tests_passed
      equals: true
    pass_score: 100
    fail_score: 0
  - dimension: cloud_test
    type: BooleanScoring
    all:
    - source: cloud.metrics.passed
      equals: true
    pass_score: 100
    fail_score: 0
  report:
    output_dir: ../output/harmony-eval/api-upgrade-skill
    format: html
```

### 5.13 API 升级：自动 Skill 有无对照

配置来源：[config/task.api-upgrade.without.yaml](../config/task.api-upgrade.without.yaml)；所有相对路径以该源 YAML 所在目录解析。

历史 without 文件名保留；without_enable=true 一次自动跑 without+with，两组使用相同 build Agent、提示词、模型和 UITest/CloudTest 判据。只运行本文件即可，不要再重复运行 5.12。

<!-- config-snapshot: config/task.api-upgrade.without.yaml -->
```yaml
schema_version: 2
scenario: APIUpgrade
id: api-upgrade-skill
description: 比较独立 OpenCode 加载/不加载 harmonyos-api-upgrade-adapter 的 API 升级任务执行结果
dataset:
  type: swe-bench-hm-multi-dev
  dir: /Users/mayism/apiupgrade
target:
  type: skills
  dir: /Users/mayism/Downloads/harmonyos-api-upgrade-adapter
skills:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: build
    without_enable: true
    timeout: 3600
    idle_timeout: 3600
    concurrency: 1
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
      sdk_home: /Applications/DevEco-Studio.app/Contents/sdk
      java_home: /Applications/DevEco-Studio.app/Contents/jbr/Contents/Home
    model:
      api_type: openai_api
      name: glm-5.3
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
  verification:
  - id: ui
    type: UITest
    deveco_home: /Applications/DevEco-Studio.app/Contents
    emulator_deployed_dir: /Users/mayism/.Huawei/Emulator/deployed
    timeout: 7200
    paths:
      hvigorw: /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw
      ohpm: /Applications/DevEco-Studio.app/Contents/tools/ohpm/bin/ohpm
      hdc: /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc
      emulatorBin: /Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator
    devices:
    - id: phone
      profile: Pura 90 Pro
      target: 127.0.0.1:15001
      hdc_port: 15001
      start_emulator: true
  - id: cloud
    type: CloudTest
    testCategories:
    - category: 24
      timeSpan: 60
    buildTimeoutSec: 1800
    taskTimeoutSec: 7200
    pollIntervalSec: 60
    product: default
    buildMode: release
    signingConfigs:
    - name: default
      type: HarmonyOS
      material:
        storeFile: /Users/mayism/code/multi-device-autorun/config/signing/test.p12
        profile: /Users/mayism/code/multi-device-autorun/config/signing/test.p7b
        certpath: /Users/mayism/code/multi-device-autorun/config/signing/test.cer
  scoring:
  - dimension: uitest
    type: BooleanScoring
    all:
    - source: ui.metrics.build_passed
      equals: true
    - source: ui.metrics.all_tests_passed
      equals: true
    pass_score: 100
    fail_score: 0
  - dimension: cloud_test
    type: BooleanScoring
    all:
    - source: cloud.metrics.passed
      equals: true
    pass_score: 100
    fail_score: 0
  report:
    output_dir: ../output/harmony-eval/api-upgrade-skill
    format: html
```

```sh
# 自动运行关闭和加载两组并比较。
harmonyeval run ./config/task.api-upgrade.without.yaml
```

### 5.14 共享 JSON 问答：独立 OpenCode 开启华为知识 MCP

配置来源：[config/qa/huawei-mcp/with/task.yaml](../config/qa/huawei-mcp/with/task.yaml)；所有相对路径以该源 YAML 所在目录解析。

使用共享 [config/qa/data/cases.json](../config/qa/data/cases.json)，开启组配置来自 [opencode.with.json](../config/qa/huawei-mcp/opencode.with.json)。LLM_judge 读取 [rubric.md](../config/qa/huawei-mcp/rubric.md)，ToolUsage 观测目标 MCP 的实际调用。该任务是自然使用 MCP 的问答评测，不强制在问题中写工具名。

<!-- config-snapshot: config/qa/huawei-mcp/with/task.yaml -->
```yaml
schema_version: 2
scenario: KnowledgeEval
id: huawei-mcp-qa
description: 同一独立 OpenCode Agent 在有/无华为开发者知识 MCP 时的问答对照
dataset:
  type: text-qa
  dir: ../../data/cases.json
target:
  type: opencode_agent
opencode_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: build
    timeout: 900
    idle_timeout: 900
    concurrency: 1
    opencode:
      config_path: ../opencode.with.json
    model:
      api_type: openai_api
      name: glm-5.3
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
      max_tokens: 8192
      temperature: 0
  verification:
  - id: quality
    type: LLM_judge
    prompt_path: ../rubric.md
  - id: usage
    type: ToolUsage
    target_mcp: harmonyos_developer_knowledge
    mode: observe
  scoring:
  - dimension: answer_quality
    type: ImmediateValue
    source: quality.metrics.score
  report:
    output_dir: ../../../../output/harmony-eval/huawei-mcp-qa
    format: html
```

### 5.15 共享 JSON 问答：独立 OpenCode 关闭华为知识 MCP

配置来源：[config/qa/huawei-mcp/without/task.yaml](../config/qa/huawei-mcp/without/task.yaml)；所有相对路径以该源 YAML 所在目录解析。

对应 5.14，使用同一份问题、标准答案、模型、build Agent 和裁判口径，改读 [opencode.without.json](../config/qa/huawei-mcp/opencode.without.json) 关闭目标 MCP。这里没有使用 without_enable；两组按实际 MCP 配置区分，不能根据 variants/with 目录名判断知识库是否启用。

<!-- config-snapshot: config/qa/huawei-mcp/without/task.yaml -->
```yaml
schema_version: 2
scenario: KnowledgeEval
id: huawei-mcp-qa
description: 同一独立 OpenCode Agent 在有/无华为开发者知识 MCP 时的问答对照
dataset:
  type: text-qa
  dir: ../../data/cases.json
target:
  type: opencode_agent
opencode_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: build
    timeout: 900
    idle_timeout: 900
    concurrency: 1
    opencode:
      config_path: ../opencode.without.json
    model:
      api_type: openai_api
      name: glm-5.3
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
      max_tokens: 8192
      temperature: 0
  verification:
  - id: quality
    type: LLM_judge
    prompt_path: ../rubric.md
  - id: usage
    type: ToolUsage
    target_mcp: harmonyos_developer_knowledge
    mode: observe
  scoring:
  - dimension: answer_quality
    type: ImmediateValue
    source: quality.metrics.score
  report:
    output_dir: ../../../../output/harmony-eval/huawei-mcp-qa
    format: html
```

```sh
harmonyeval run ./config/qa/huawei-mcp/without/task.yaml
harmonyeval run ./config/qa/huawei-mcp/with/task.yaml
harmonyeval compare <without_run_dir> <with_run_dir> --output ./output/huawei-mcp-qa-comparison
```

基础 MCP 的服务地址、启用状态和 HTTP/本地启动方式仍由 OpenCode JSON 定义，不在任务 YAML 重复声明。预检只确认相应准备项，不证明远端工具返回成功；完整运行方法见 [config/qa/README.md](../config/qa/README.md)。

### 5.16 共享 JSON 问答：HTTP 智能客服本地桩

配置来源：[config/qa/customer-service/task.yaml](../config/qa/customer-service/task.yaml)；所有相对路径以该源 YAML 所在目录解析。

与 5.14/5.15 共用 config/qa/data/cases.json；请求本地 http://127.0.0.1:18081/answer，发送 case_id 和 question，从 data.answer、data.session_id 提取结果。默认 ExactMatch+ImmediateValue 仅用于验证协议与评测链路，不调用裁判模型；其分数不能直接与 MCP 两组的语义评分比较。

<!-- config-snapshot: config/qa/customer-service/task.yaml -->
```yaml
schema_version: 2
scenario: QuestionAnswering
id: customer-service-stub
description: 本地客服 URL 冒烟，验证 JSON 用例、HTTP 请求和确定性评分
dataset:
  type: text-qa
  dir: ../data/cases.json
target:
  type: knowledge
knowledge:
  rounds: 1
  static_eval: {}
  execution:
    engine: http
    http_url: http://127.0.0.1:18081/answer
    method: POST
    timeout: 30
    concurrency: 2
    request:
      json:
        case_id: ${case.case_id}
        question: ${case.question}
    response:
      protocol: json
      answer_path: data.answer
      session_id_path: data.session_id
  verification:
  - id: answer
    type: ExactMatch
  scoring:
  - dimension: answer_correctness
    type: ImmediateValue
    source: answer.metrics.score
  report:
    output_dir: ../../../output/harmony-eval/customer-service
    format: html
```

先在一个终端启动桩服务，再在另一个终端执行任务；桩服务需在评测期间保持运行。

```sh
python scripts/qa_customer_stub.py --port 18081
```

```sh
harmonyeval run ./config/qa/customer-service/task.yaml --check
harmonyeval run ./config/qa/customer-service/task.yaml
```

接入真实客服时替换 URL、请求响应映射和认证，按业务改用语义裁判或专用验收；不要向被测 URL 发送 reference_answer。

### 5.17 三方库转换：通用 Plugin 模板

配置来源：[config/examples/task.library-plugin.yaml](../config/examples/task.library-plugin.yaml)；所有相对路径以该源 YAML 所在目录解析。

这是通用模板，区别于 5.4/5.10 的本机 hmos-library-adapter-fast 任务。当前模板是 without_enable=true、agent_name=build；插件路径、入口、用例、模型和 rubric 需要按实际插件补齐。Plugin 包名不能自动当作 Agent ID。

<!-- config-snapshot: config/examples/task.library-plugin.yaml -->
```yaml
schema_version: 2
scenario: LibraryMigration
id: library-conversion-plugin
description: 不加载目标三方库转换 Plugin 的基线评测
dataset:
  type: library-migration
  dir: ../../datasets/libraries
target:
  type: plugin_agent
  dir: ../../capabilities/library-plugin
  entry: ./dist/index.js
plugin_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: build
    timeout: 1800
    idle_timeout: 300
    without_enable: true
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
  verification:
  - id: api
    type: LibraryAPICount
  - id: code
    type: whiteboxeval
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
    rubric_path: ./rubrics/library-migration.yaml
  scoring:
  - dimension: api_count_consistency
    type: ImmediateValue
    source: api.metrics.count_consistency
    scale: 100
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
  report:
    output_dir: ../../outputs/library-conversion-plugin
    format: html
```

### 5.18 一多适配：通用模板

配置来源：[config/examples/task.multidev.yaml](../config/examples/task.multidev.yaml)；所有相对路径以该源 YAML 所在目录解析。

这是通用模板，区别于 5.2 中已配置本机 SDK 与三台设备的实际任务。复制后需要设置有效 HarmonyBot 来源、用例目录、设备/工具链和模型；不应把模板中的路径和设备占位当成本机可运行配置。

<!-- config-snapshot: config/examples/task.multidev.yaml -->
```yaml
schema_version: 2
scenario: MultiDev
id: multidev-harmonybot
description: 评测 HarmonyBot 一多 Agent 的适配效果
dataset:
  type: swe-bench-hm-multi-dev
  dir: ../../datasets/multidev
target:
  type: harmonybot_agent
  dir: /path/to/vscode/extensions
harmonybot_agent:
  rounds: 1
  static_eval: {}
  execution:
    engine: opencode
    agent_name: harmonyos-multi-device
    timeout: 900
    idle_timeout: 300
    enviroment:
      deveco_home: /Applications/DevEco-Studio.app/Contents
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
  verification:
  - id: ui
    type: UITest
    deveco_home: /Applications/DevEco-Studio.app/Contents
    emulator_deployed_dir: /path/to/emulators
    devices:
    - id: phone
      profile: Pura 90 Pro
      target: 127.0.0.1:15001
      hdc_port: 15001
      start_emulator: true
  - id: code
    type: whiteboxeval
    model:
      api_type: openai_api
      name: qwen-plus
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: DASHSCOPE_API_KEY
  scoring:
  - dimension: L1
    type: BooleanScoring
    all:
    - source: ui.metrics.build_passed
      equals: true
    - source: ui.metrics.all_tests_passed
      equals: true
    pass_score: 100
    fail_score: 0
  - dimension: L2
    type: WeightedSummation
    mode: deduction
    base_score: 100
    components:
    - name: UX
      source: ui.metrics.pass_rate
      range:
      - 0
      - 1
      weight: 0.5
    - name: Whitebox
      source: code.dimensions
      reducer: proportional_deduction
      cap_source: code.metrics.total_score
      weight: 0.5
    missing: unavailable
  - dimension: L3
    type: ImmediateValue
    source: code.metrics.total_score
  report:
    output_dir: ../../outputs/multidev-harmonybot
    format: html
```
