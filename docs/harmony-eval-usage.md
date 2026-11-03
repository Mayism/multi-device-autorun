# Harmony Eval v2 使用说明

更新日期：2026-11-02。实际任务配置与各场景示例见[YAML 示例册](harmony-eval-task-examples.md)。本文中的密钥只使用环境变量名。task.yaml 的字段、必填项、默认值和全部内置枚举见[字段参考](harmony-eval-config-reference.md)，其他仓库的迁移步骤与验收要求见[重构实施指南](harmony-eval-framework-design.md)。

新增业务验证器或扣分规则见[扩展开发指南](harmony-eval-extension-guide.md)，其中说明如何自行创建并注册独立扩展包，无需修改主框架。

入口是 `harmonyeval run ./config/task.yaml`。通用框架直接接入 EvalScope 1.14.x 的 DataAdapter、DefaultEvaluator、预测/评估缓存、SampleScore 和报告生命周期。OpenCode 正式模型请求通过每个样本独立的 EvalScope Model Proxy；HTTP 后端通过 HttpAgentModelAPI 进入同一生命周期。

## 安装与命令

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[eval]'

harmonyeval plan ./config/task.yaml
harmonyeval run ./config/task.yaml --check
harmonyeval run ./config/task.yaml
```

`plan/--check` 解析数据集并检查实际 Agent/Plugin/Skill 装载，不请求生成模型。模型配置的 `api_key` 可填环境变量名，也兼容直接填写包含连字符、点等字符的密钥；合法环境变量名格式的字符串按变量名解析。直接填写的密钥在加载后换成进程内引用，生成的配置快照与报告不包含密钥。白盒评估器省略 model 时复用 execution.model，无需 YAML 锚点；需要独立裁判模型时再显式填写。当前参考仓库的 `static_eval` 仅保留字段，不执行、不计分；这不适用于另一个已经实现静态评测的目标仓库，迁移时须保留其原有能力。所有相对路径以任务 YAML 所在目录为基准。

预检通过仅表示配置、依赖和运行时能力装载检查通过，不能证明 API Key 已获服务授权、MCP 已连通或真实设备/编译已成功。密钥失效仍可能在正式模型请求时返回 401。

```sh
harmonyeval verify ./config/task.yaml --run ./output/harmony-eval/<run_id>
harmonyeval rescore ./config/task.yaml --run ./output/harmony-eval/<run_id>
harmonyeval compare <without_run_dir> <with_run_dir> --output ./output/comparison
```

`verify` 使用保存的答案/工程重新评估；`rescore` 只用已有验证指标重新算分。输入、执行配置或能力源变化会拒绝复用；参考资料、评估规则变化要求先 verify。compare 校验输入、模型/执行预算和评分规则，按 case_id+轮次配对，差值为右组减左组，并显示两组完成数、失败数和配对覆盖。

## 一份 YAML 执行 MCP 多组实验

使用 `config/task.library-plugin.mcp.yaml` 可以在两组均加载三方库插件的前提下比较 MCP 效果：

```sh
export ZHIPU_API_KEY='<你的密钥>'
harmonyeval run ./config/task.library-plugin.mcp.yaml --check
harmonyeval run ./config/task.library-plugin.mcp.yaml
```

模型沿用当前三方库任务的 `glm-5.3` 和 Coding Plan 地址，密钥改用环境变量。公共配置仍在 `target` 和 `plugin_agent` 中定义；基础 MCP 的 URL/command 放在 `execution.opencode.config_path` 指向的 `config/opencode.library-mcp.json`，在 YAML 顶层添加：

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

- `experiments` 可选；省略时保留原单组执行行为。支持所有 `engine: opencode` 的目标，包括 Plugin、Skill、HarmonyBot Agent、独立 OpenCode Agent，不支持 HTTP 智能问答后端的远端配置覆盖。
- 每组仅允许 `id`、`overrides.mcp.<名称>.enabled`；`enabled` 必须是布尔值。所有组必须显式列出同一组 MCP 名称，最多 100 组，ID 唯一且满足任务 ID 的格式要求。
- MCP 必须在基础配置中完整声明，缺少服务器定义或 URL/command 会在开始执行前失败。覆盖只应用到系统临时目录中的运行副本，不改全局配置或基础 JSON。
- 框架按 YAML 顺序执行各组，每组仍通过 EvalScope 调度全部用例和轮次。各组的模型、提示词、Plugin/Skill、Agent、验证和评分相同；`without_enable` 必须为 false/省略，目标插件/Skill 在 MCP 各组均加载；它不能用作 MCP 开关。
- 第一组作为基准，后续每组自动与其比较，差值为后续组减基准组。只有声明的 MCP enabled 差异被忽略；其他 MCP、URL/command、实际 OpenCode 配置、Agent、模型、能力源、用例或评分变化会拒绝对比。
- 一组失败仍继续后续组并保留诊断；失败或证据不足不转换为零分。配置和实际装载证据不足时，对比显示 unavailable。任一组执行/评分不完整或比较不可用，命令退出码为 1；有效业务零分不会导致基础设施失败。
- 示例增加了 `ToolUsage` 观察 MCP 调用。加载成功不代表使用了知识，开启组仍需检查 `mcp_usage` 的调用和成功次数。

结果结构：

```text
report.output_dir/<run_id>/
├── task.resolved.yaml
├── experiments-report.json
├── index.html                         # 所有实验组和对比的汇总入口
├── experiments/
│   ├── without_mcp/                    # 各自的 task-report.json、index.html、EvalScope 产物
│   │   └── variants/without_mcp/round-01/cases/<id>/base/
│   └── with_mcp/
│       └── variants/with_mcp/round-01/cases/<id>/base/
└── comparisons/with_mcp/               # 当前组减基准组：comparison.json、index.html
```

复评、复算或手动 compare 时指定 `experiments/<实验ID>/` 子目录，继续使用同一份任务 YAML；框架按报告的实验 ID 和覆盖配置匹配，禁止复用开关已变更的旧结果。复评/复算后会刷新批次汇总和对比；规则只更新一组时，两组规则不一致，对比暂为 unavailable，全部组更新完成后恢复：

```sh
harmonyeval rescore ./config/task.library-plugin.mcp.yaml --run <run_dir>/experiments/with_mcp
harmonyeval compare <run_dir>/experiments/without_mcp <run_dir>/experiments/with_mcp --output <comparison_dir>
```

## thirdcase 的插件对照

已准备：

- `config/task.yaml`：默认选择加载插件的 thirdcase 任务，其他配置块保留为目录，只有 target.type 对应的块生效。
- `config/task.library-plugin.with.yaml`：独立 OpenCode + hmos-library-adapter-fast Agent。
- `config/task.library-plugin.without.yaml`：历史文件名保留，without_enable=true，现在一次执行 without+with 并自动比较；无需再运行 with 文件。

当前模型配置有区别，运行前按实际文件选择：

| 文件 | 模型与生成参数 | 目标 |
|---|---|---|
| `config/task.yaml` | `glm-4.7`，`max_tokens: 8192`，`temperature: 0.7` | 默认加载插件 |
| `config/task.library-plugin.with.yaml` | `glm-5.3`，未显式指定生成参数 | 加载插件 |
| `config/task.library-plugin.without.yaml` | `glm-5.3`，未显式指定生成参数 | 自动 without+with 两组 |
| `config/task.multidev.yaml` | `glm-5.3`，未显式指定生成参数 | HarmonyBot 一多 Agent |

未指定时当前模型适配器默认 `max_tokens: 4096`、`temperature: 0`、`retries: 1`。因此默认 task.yaml 和独立 without 任务目前不是只改变插件开关的对照组；需对照时直接运行 without_enable=true 的一键对照任务。

两份配置都读取 `/Users/mayism/thirdcase`；当前识别到 `advanced_in_app_review`。源目录不修改，执行工程复制到每个样本的产物目录。Plugin、配置和数据库放入系统临时目录；关闭组会同时移除目标 Plugin 的配置引用、自动发现入口和关联技能。运行不会修改现有独立 OpenCode/HarmonyBot 配置。

被测插件只在 `target.type: plugin_agent` 和 `target.dir` 声明，不需要 execution.opencode.plugins。默认从 `package.json.main` 读取入口（未声明时使用 index.js）；非默认入口可用 target.entry 覆盖，初始化选项用 target.options。独立 OpenCode 默认从 PATH 查找，使用默认宿主配置时可省略整个 execution.opencode；仅在指定可执行文件或额外配置时设置其中的 binary/config_path。

```sh
# 独立 with/without 任务使用 glm-5.3；默认 task.yaml 使用 glm-4.7。
# 两者均使用智谱 Coding Plan 专用接口。
# 仅在api_key填写ZHIPU_API_KEY变量名时需要export；直接填密钥时省略。
export ZHIPU_API_KEY='your-key'
# 一次跑两组并自动比较，不再分别运行 with/without 文件。
harmonyeval run ./config/task.library-plugin.without.yaml --check
harmonyeval run ./config/task.library-plugin.without.yaml
```

当前本机插件任务使用 `https://open.bigmodel.cn/api/coding/paas/v4`，与智谱普通API端点不同，按[智谱官方OpenCode接入说明](https://docs.bigmodel.cn/cn/coding-plan/tool/opencode)配置。白盒评估省略 model 时继承同一配置。

without_enable=true 自动执行不加载对象的 without 与加载对象的 with；false/省略只跑 with。agent_name 指 with 组 Agent；Plugin 的 without 组默认 build，可用 without_agent_name 指定其他宿主 Agent。Skill 两组默认同一 Agent。当前 Flutter 库还需要实际 Flutter SDK，在 execution.enviroment.flutter_home 配置；本机默认 PATH 尚未发现 flutter。

该字段语义已从“本次关闭对象”改为“追加 without 对照”。旧版本 true 只跑一个关闭组，不能把这种旧报告直接当作新双组任务复用。新任务的汇总入口为批次 index.html；两组位于 experiments/without/、experiments/with/，自动差值位于 comparisons/with/。verify/rescore 仍使用同一 YAML，但 --run 指向其中一个单组目录。

当前三方库配置使用 LibraryAPICount 和独立白盒评估，输出 api_count_consistency（0—100）与 L3；不启用 LibraryTests / LibraryAPICompatibility，因此不要求先准备构建/功能验收命令和 API 映射。数量检查通过不能据此宣称通过编译、设备验证或功能验收；这些评估器可后续按需启用。

### 第一版三方库验收：API 数量

```yaml
verification:
  - id: api
    type: LibraryAPICount
scoring:
  - dimension: api_count_consistency
    type: ImmediateValue
    source: api.metrics.count_consistency
    scale: 100
```

Agent 执行前保存原工程的 input-evidence.json，执行后统计 base/ 的目标工程；复评沿用执行前快照，不读取修改后的工程伪造基线。各类别分别统计公开类型、方法／函数、属性／常量，输出转换前后数量、差值、带文件与行号的声明清单。产物位于用例目录的 verification/api/ 下：api-count.json 和 api-count.md。

- count_match：三类数量分别全部一致；total_match 仅表示总数相等。
- count_consistency：各类别 min(转换前数量, 转换后数量) 之和，除以各类别 max(转换前数量, 转换后数量) 之和。缺少或额外增加 API 都会降低分数；总数相同但类别不同也不满分。
- 统计采用语法树，支持 Dart、TypeScript、TypeScript 兼容的 ETS、ES 模块 JavaScript、Java、Kotlin。Dart 名称以下划线开头的声明、Java 非 public 成员、TS/JS 私有或 protected 成员、Kotlin private/protected/internal 声明均排除；JS/TS 统计显式导出声明及其公开成员。
- 重载按同一文件内的限定名称合并，getter/setter 合计一个属性；不统计构造函数、隐式生成或继承的成员，不展开外部 re-export，不比较签名、名称对应或功能实现。扫描范围内的内部 re-export 不额外增加计数。
- 默认排除测试、示例、依赖和构建目录。Flutter 工程默认统计 lib/ 中的 Dart 声明；其他工程优先 ETS/TS，再 ES 模块 JS，随后 Dart/Java/Kotlin。解析失败、不支持的源码或原库无公开声明时标记 unavailable，不能记作数量检查通过。

自动范围不适合某个库时，可在验证器配置 source_paths/target_paths（相对原工程/目标工程的文件或目录数组）、source_languages/target_languages（语言数组）。例如目标是独立 ArkTS 库但保留了原 Dart 代码时，显式指定 target_languages: [typescript]。统计口径是选定源码范围内的显式公开声明，不等同于完整解析包的导出边界；CommonJS 和 ETS 专有语法需后续扩展提取器。

## 原一多适配的 YAML

`config/task.multidev.yaml` 已写入用例目录 `/Users/mayism/cases`、HarmonyBot 扩展目录和 DevEco/Java/SDK 路径，所有配置均由 YAML 提供。Agent 为 harmonyos-multi-device，使用独立三方库任务的 glm-5.3 模型配置。

- 设备：Pura 90 Pro（15001）、Mate X7（15005）、MatePad Pro 13（15008）。
- 执行并发 3，总时限与主 CLI 静默时限均为 3600 秒，UITest 时限 7200 秒。
- L1：编译且测试全部通过；L2：UITest 通过率代表 UX 占 50%，白盒按维度比例扣分占 50%；L3：白盒总分。缺证据时 unavailable。
- 输出：`output/harmony-eval/multidev-harmonybot/<run_id>/`。

```sh
source /tmp/harmony-eval-venv312/bin/activate
harmonyeval run ./config/task.multidev.yaml --check
harmonyeval run ./config/task.multidev.yaml
```

这是本机已有虚拟环境路径，也可使用文首新建的 .venv。生成 YAML 时识别到 CaseBookRead（metadata.case_id: bookread-template-derive-base）。随后检查实际运行 20261101225142-fa8346，三设备共执行 48 项、47 项通过，平板有 1 项失败；白盒超出证据预算而不可用，不能据此认定全部验收通过。需要选择子集时在 dataset.case_ids 中填写元数据 ID，而非强制使用文件夹名。

任务入口已统一为 harmonyeval，旧 JSON 配置、Autorun 批量命令、独立云测试任务命令及旧 OpenCode 服务启动命令已移除。设备 Runner、云测试提交/轮询和白盒底层工具保留。更新代码后重新执行 `python -m pip install -e '.[eval]'` 刷新已安装入口。`python -m harmonyeval` 和 `python -m harmonyeval.cli` 都使用同一套 run/plan/verify/rescore/compare 子命令，不再接受旧 --config 参数。

## 数据集格式

### 一多

`dataset.type: swe-bench-hm-multi-dev` 沿用每个用例的 base/或task/、PROMPT.md、metadata.json、test_patch.patch 和 golden_patch.patch。工程生成后再在评估侧应用测试补丁；不会给被测 Agent 复制参考补丁。Web 用例保留 base 与 web 工程关系；Flutter/RN 沿用现有 ohosTest 执行流程。

Agent 停止后，一多适配器将 metadata.json 以及声明的 test_patch/golden_patch 归档到该用例结果目录，补丁保留原相对路径，超时或报错也归档；verify 会补齐归档。测试临时目录清理不再带走这些输入证据。

### 三方库、安卓应用迁移

推荐 `library-migration` 或 `android-migration`，目录下每个子目录有 case.yaml：

```yaml
id: sample-library
input:
  project: ./source
  instruction: ./PROMPT.md
expected:
  tests: ./grading/tests
  api_mapping: ./grading/api-mapping.yaml
verification:
  tests:
    build_command: [node, --check, index.js]
    test_command: [node, test.js]
    junit_path: ./junit.xml
```

产物类型由提示词确定，不再配置 expected.output_kind/output_project。各用例的统一工程产物目录为 `variants/<with|without>/round-XX/cases/<id>/base/`，Agent 在该目录执行，目标工程根目录直接放在这里；框架会向迁移任务附加此约定。不同用例不会共用一个可写目录。Web 组合用例保留目录内部的容器工程与 web/ 关系。

可选的 input.target_template 用于提供目标工程模板：模板放入 base/，原工程副本放入同级 input/，提示词会告知 Agent 从 ../input/ 读取原工程。未提供模板时，原工程直接复制到 base/，可在副本内完成转换。

上面的命令仅展示配置方式，真实鸿蒙库应替换为其实际构建/测试命令。LibraryTests 内部复制生成工程、复制 grading/tests 到 evaluation-tests（tests_destination 可改）、执行构建和功能测试，读取 JUnit 统计。命令是参数数组，不通过 shell 拼接；支持 `${project}`、`${output}`。没有 JUnit 时，只有显式设置 exit_code_is_test_result=true 才把整条测试命令的结果视作一个通过率指标。

原始仓库没有 case.yaml 时可明确选择：

```yaml
dataset:
  type: library-migration
  dir: /path/to/thirdcase
  layout: repositories
  instruction: 请在当前工程内完成鸿蒙适配，保持公开API和原有平台行为。
  verification:
    tests:
      build_command: [your-build-command]
      test_command: [your-test-command]
      junit_path: ./junit.xml
```

repositories 表示 dir 本身是一个源工程，或其直接子目录各为一个源工程。构建/测试规范可在 dataset.verification 中共享；不同库规范不同时使用 case.yaml 的逐用例元数据。`dataset.case_ids` 可选部分用例，`limit` 可用于小规模试跑。

API 映射例子：

```yaml
apis:
  - source: OriginalApi
    target: HarmonyApi
    file: src/main/ets/Index.ets
    required_symbols: [HarmonyApi, evaluate]
    weight: 1
```

coverage 是声明的目标符号覆盖率，行为等价仍需功能测试。评估专用文件由评估侧使用，不传给生成 Agent。

### 文本问答

`dataset.type: text-qa` 接收 JSON/JSONL 文件或包含这些问答文件的目录。JSON 可为用例数组或含 cases 数组的对象；原 JSONL 格式继续支持。单个标准答案字段 reference_answer 会规范化为 reference_answers 数组，metadata 可记录业务分类和参考日期。例如：

```json
[{"id":"q1","question":"2+3，只回答整数","reference_answer":"5","criteria":["结果正确"],"reference_documents":[]}]
```

相同数据可评标准 OpenCode、HarmonyBot、MCP 开关实验和 HTTP 智能问答。knowledge 表示 HTTP 智能问答；本地 MCP 任务可通过顶层 experiments 覆盖运行副本的 MCP enabled，也可继续使用原有两份 OpenCode 配置。

已生成三份独立任务：config/qa/huawei-mcp/with/task.yaml、without/task.yaml 和 config/qa/customer-service/task.yaml。三个任务统一读取 config/qa/data/cases.json 的三个 HarmonyOS 知识问答，并共用 data/references；MCP 两组使用相同语义裁判和模型，只改变目标 MCP enabled。客服默认通过 scripts/qa_customer_stub.py 提供本地 URL，相同三个问题走 ExactMatch，无需模型；该确定性桩仅验证 HTTP/评分链路，不能直接与语义评分作质量排名。数据字段、启动、正式对照和更换真实客服后的语义评分配置见[问答任务说明](../config/qa/README.md)。

## 执行环境与评估流程

`execution.engine` 选择执行器，`execution.enviroment` 配置 deveco_home、flutter_home、sdk_home、java_home。独立 OpenCode 的 binary/config_path 放在 execution.opencode。HarmonyBot 自动定位有效 Bundle，并在私有副本合并 config_path；不会用仅含 MCP 的补充配置覆盖原有 Agent/Plugin 定义。

runtime_config 已取消；execution.runtime 已更名为 enviroment。产物根目录固定为各用例的 base/，不再设置 expected.output_kind/output_project。Skill/Plugin 对照使用 without_enable=true 自动跑两组，无需 comparison 或 experiments；harmonybot_agent/opencode_agent 不接受该开关。MCP 基础配置来自实际 opencode.json；可通过 experiments 在运行副本中覆盖 enabled。

verification 的条目是完整评估流程，不单列编译节点。支持 UITest、CloudTest、LibraryAPICount、LibraryTests、LibraryAPICompatibility、whiteboxeval、LLM_judge、ExactMatch、ToolUsage、Command、SkillVerifier 和 Workflow。id 用于评分引用，depends_on 表达流程间的结果依赖；各流程在独立工程副本执行，设备按目标地址串行占用。评估器可选实现异步 capture_input(case, config)，在 Agent 执行前冻结 JSON 输入证据；后续 verify 读取相同证据。

- UITest 内部调用现有 Python ohosTest CLI，编译、安装、执行及截图能力沿用现有设备层，继承 YAML 环境；独立进程避免并发修改共享环境变量。
- CloudTest 复用现有 AGC 客户端与报告；认证使用现有 AGC 环境变量。文本 test_category 需提供明确 category_mapping，不能猜测服务数字类别。
- whiteboxeval 是独立评估请求的结构化源码/rubric 评价，省略 model 时复用执行模型；L3 取总分，L2 可按维度分配扣分并保留总分封顶。不把白盒判断当成已执行的设备测试。空返回、无效 JSON、缺失维度或超出源码证据预算时 unavailable，judge.json 保留可获得的原始回复。
- AGCDetection 与 CloudTest 分别配置：须提供 command 或明确 HTTP 协议，不能仅填名称就假设某个未知服务可用。
- ToolUsage 记录 configured、enabled、attempted、succeeded，依据已归档的工具调用统计，不提供通用 MCP 连接探针或答案引用核验。未观测到调用不代表已使用知识；当前流程只观测，不把预期关闭的 MCP 判为失败。
- SkillVerifier 启动独立 OpenCode 评估会话执行验证 Skill，并校验返回 JSON Schema。被测 Skill 的 activation: required 由主执行器另行检查成功的 skill(name) 调用，不自动启动 SkillVerifier。

设备资源锁当前只在同一评测进程内生效，以 target 地址标识；多个独立评测命令之间没有跨进程设备锁。新 MCP 对照建议使用 experiments，比较时只忽略声明的 MCP 开关。原有未配置 experiments 的 KnowledgeEval 直接 Agent 对照保留旧行为：宿主指纹忽略全部 MCP enabled，需人工确认目标开关范围。

组合流程不需要改核心代码：

```yaml
verification:
  - id: custom
    type: Workflow
    steps:
      - id: rule
        type: ExactMatch
    metrics:
      score: rule.metrics.score
```

也可用 workflow_path 指向独立工作流文件，其中的相对路径以该文件所在目录为基准，支持嵌套与循环引用校验。复评身份包括流程文件、提示词、rubric、Skill 内容和适配器版本，内容改变后不会把旧评分当作最新结果。新工具适配器可通过 Python 包 entry points 注册到 harmonyeval.datasets、harmonyeval.targets、harmonyeval.execution、harmonyeval.verification、harmonyeval.scoring、harmonyeval.http_protocols；注册项可声明 schema、validate、version，框架不维护场景 if/else 分发表。

## 输出与验证范围

`report.output_dir/<run_id>/` 下保存 task.resolved.yaml、task-report.json、index.html、EvalScope 原生缓存，以及 variants/<with|without>/round-XX/cases/<id>/ 下的工程、change.patch、Agent 轨迹及必要评估证据。配置快照脱敏，不保存模型密钥。可重建的运行配置、数据库及评估工程副本使用系统临时目录。

原 autorun 的 .ohostest-runs/<timestamp>/ 在 YAML 入口改为用例目录的 verification/<UITest id>/，当前配置为 verification/ui/，保留 result.json、commands.jsonl、summary.md 及 swe/ 测试证据；work/ 测试工程在结束时清理。新入口通过 --out 显式指定路径，不再复制出一份 .ohostest-runs；截图以设备 Runner 实际生成结果为准。

generate/agent-output.html 是会话浏览入口；agent-output.json 保存结构化会话及模型代理轨迹，events.jsonl 是 OpenCode CLI 原始事件，stderr.jsonl 是进程错误输出。执行器在删除运行期数据库前，仅从本次私有 XDG_DATA_HOME 只读导出主会话和沿 parent_id 关联的后代会话，不搜索用户全局数据库。session_capture 字段说明实际导出模式；数据库不兼容时明确回退为 CLI 事件。插件通过 Bash 单独启动 opencode run 形成的新根会话可能没有父子关联，当前不会导出它们；需结合 Bash 输出和插件日志，不能将主/后代页面称为所有子进程的完整日志。超时也保存已有回复、可获取的子会话和模型轨迹。

OpenCode CLI 的主会话事件流可能不显示子 Agent 的实时工具进度。idle_timeout 当前只检测主 CLI stdout 静默，未实现子 Agent 活动心跳。三方库插件与本机一多配置将 idle_timeout 与 timeout 同设为 3600 秒，通过总时限控制整轮执行，避免子 Agent 下载依赖、分析或构建时因主会话静默 5 分钟而被提前终止；这是规避误判的配置措施。需要更长执行时间时调整两者；进程结束不等同于转换成功，仍以执行状态和评估证据为准。

运行目录隔离不构成文件访问沙箱：当前真实 HOME 保留、运行权限为 allow，绝对路径仍可访问源用例或其他目录。golden/test patch 后复制不会阻止主动跨目录读取。此前图库/iCloud 访问现象尚未确认本地触发源，不能认定已读取或上传；严格目录访问限制需另行实现系统/容器级隔离。

本地自验证覆盖 EvalScope HTTP 生命周期、真实 OpenCode+本地模型代理的工具调用/生成/功能测试、Plugin/Skill/MCP 配置隔离、失败与缺失证据、复评与复算和扩展流程。真实 DevEco 编译、模拟器/真机、AGC 服务仍需对应工具链、设备和账号后执行；本地模拟通过不等于真实库已转换成功。

自验证命令（已安装 `.[eval]` 的 Python 环境）：

```sh
python -m unittest discover -s tests -p 'test_harmony_eval*.py' -v
HARMONY_EVAL_INTEGRATION=1 python -m unittest discover -s tests -p test_harmony_eval_opencode.py -v
```

第二条需要本机独立 OpenCode，使用本地模型服务，不请求付费模型。历史提交 3795791 前的验证共 71 项通过；后续目录重构的验证范围与结果见[实现参考中的历史验证记录](harmony-eval-implementation-reference.md#12-当前代码结构与验证状态)，这些是各阶段记录，不是每次执行都会更新的验收结论。generate/harmony-eval-validation.json 同样是本地阶段记录，不随代码提交，也不保证随每次运行更新。

已观察到一次真实三方库任务约 20 分 57 秒生成 ohos/ 和 example/ohos/，数量检查 100；由于缺 Flutter/Dart，未完成真实 HAP 编译和设备验证，白盒空返回也未形成有效分数。该记录不能当作适配成功验收。

## 新场景开发入口

各场景通过同一 harmony_eval benchmark 接入 EvalScope：dataset 提供用例，target/execution 执行任务，verification 产出证据和指标，scoring 计算分数。当前不需要逐场景注册 EvalScope benchmark，CLI 也未开放任意 benchmark 选择字段。

开发前读取仓库 [harmonyeval Skill](../.agents/skills/harmonyeval/SKILL.md)；[重构指南的验收与交付要求](harmony-eval-framework-design.md#8-怎样验收和交付) 列出各场景的工作分工与交付清单，[扩展指南](harmony-eval-extension-guide.md) 提供验证器和评分器的具体实现方式。[AGENTS.md](../AGENTS.md) 为开发 Agent 提供相同入口。
