# 各场景 YAML 完整示例

这是[重构实施指南](harmony-eval-framework-design.md)的配套示例册，保留参考仓库全部 **18 份任务配置快照**。需要实现某个场景时再查相应示例，不必先通读所有配置。

本册中的 /Users/mayism、SDK 路径、模型名称、插件位置和设备地址来自参考机器，迁移 Agent 必须替换成目标仓库环境；不能复制后便宣称可运行。明文凭据已替换为环境变量名或占位。相对路径仍按标注的源 YAML 所在目录解释。

**static_eval 的特别说明：**部分快照包含 static_eval: {}，只反映参考仓库该字段尚未接入。目标仓库已有静态评测时，必须保留原配置和实际行为，不能用这里的空对象覆盖它。保留方式见主指南第 3 节。

## 1. 参考仓库的当前任务

以下为参考仓库在 2026-11-02 的配置快照；不是目标仓库的默认配置。实际运行以对应 YAML 文件为准。当前 10 份任务配置与 8 份通用模板均已收入本册第 2 节索引，默认 task.yaml 的活动块快照放在 1.1。文档中不保存明文模型密钥或签名密码；未启用的历史目标块、占位路径和空报告设置不代表已经可运行。

| 任务文件 | 活动目标 / Agent | 模型 | 验证与评分 |
|---|---|---|---|
| [config/task.yaml](../config/task.yaml) | plugin_agent / hmos-library-adapter-fast；只跑 with | glm-4.7 | LibraryAPICount、whiteboxeval → api_count_consistency、L3 |
| [config/task.multidev.yaml](../config/task.multidev.yaml) | harmonybot_agent / harmonyos-multi-device | glm-5.3 | UITest、whiteboxeval → L1、L2、L3 |
| [config/task.library-plugin.with.yaml](../config/task.library-plugin.with.yaml) | plugin_agent / hmos-library-adapter-fast；只跑 with | glm-5.3 | LibraryAPICount、whiteboxeval → api_count_consistency、L3 |
| [config/task.library-plugin.without.yaml](../config/task.library-plugin.without.yaml) | plugin_agent / hmos-library-adapter-fast；自动 without+with | glm-5.3 | LibraryAPICount、whiteboxeval → api_count_consistency、L3 |
| [config/task.library-plugin.mcp.yaml](../config/task.library-plugin.mcp.yaml) | plugin_agent / hmos-library-adapter-fast；只跑 with；MCP 两组 | glm-5.3 | LibraryAPICount、whiteboxeval、ToolUsage → api_count_consistency、L3 |
| [config/task.api-upgrade.with.yaml](../config/task.api-upgrade.with.yaml) | skills / build；只跑 with | glm-5.3 | UITest、CloudTest → uitest、cloud_test |
| [config/task.api-upgrade.without.yaml](../config/task.api-upgrade.without.yaml) | skills / build；自动 without+with | glm-5.3 | UITest、CloudTest → uitest、cloud_test |
| [config/qa/huawei-mcp/with/task.yaml](../config/qa/huawei-mcp/with/task.yaml) | opencode_agent / build | glm-5.3 | LLM_judge、ToolUsage → answer_quality |
| [config/qa/huawei-mcp/without/task.yaml](../config/qa/huawei-mcp/without/task.yaml) | opencode_agent / build | glm-5.3 | LLM_judge、ToolUsage → answer_quality |
| [config/qa/customer-service/task.yaml](../config/qa/customer-service/task.yaml) | knowledge / HTTP URL | 后端管理；本地桩不调用模型 | ExactMatch → answer_correctness |

默认 task.yaml 使用 glm-4.7，显式 max_tokens=8192、temperature=1.7；独立三方库 Plugin、一多、API 升级和 MCP 问答任务使用 glm-5.3，具体生成参数见对应快照，不能把默认任务与独立任务当成只切换了能力开关的对照。未显式指定时，当前模型适配器默认 max_tokens=4096、temperature=0、retries=1；白盒/Judge 省略 model 时按实现继承执行模型。HTTP 后端模型由服务自行管理，不能从 task YAML 推断其内部模型。

### 1.1 `config/task.yaml` 的生效配置

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

### 1.2 本机执行命令

```sh
# 本机已安装 EvalScope 的 Python 3.12 环境；也可按使用说明建立自己的 .venv。
source /tmp/harmony-eval-venv312/bin/activate
# api_key 填环境变量名时，在当前终端设置 ZHIPU_API_KEY。
harmonyeval run ./config/task.yaml --check
harmonyeval run ./config/task.yaml

# 一次跑 without+with 并自动比较；历史 without 文件名保留。
harmonyeval run ./config/task.library-plugin.without.yaml

# 原一多配置对应的新 YAML，完整配置见本册 2.1。
harmonyeval run ./config/task.multidev.yaml --check
harmonyeval run ./config/task.multidev.yaml

# API 升级 Skill 自动双组对照。
harmonyeval run ./config/task.api-upgrade.without.yaml
```

任务入口已统一为 harmonyeval。旧 JSON 配置及其加载器、Autorun 批量入口、独立云测试命令和旧 OpenCode 服务启动命令已移除；一多的用例目录、工具链和三台设备参数由 YAML 自身提供。设备 Runner、云测试提交/轮询及白盒共用实现保留。Python 模块入口 harmonyeval、harmonyeval.cli 同样进入 Harmony Eval，不再接受旧 --config 参数。

`plan/--check` 不请求生成模型，不能验证密钥是否有服务权限，也不等于 HAP 构建、设备连通或 MCP 远端调用已成功。它检查数据集、依赖、凭据是否配置，以及 OpenCode 实际装载的 Agent/Plugin/配置。MCP 连通性和返回资料需要实际工具调用证据。

## 2. 各场景完整 YAML

本节及 1.1 同步当前仓库 **18 份任务 YAML**：10 份当前任务配置、8 份 config/examples/ 通用模板。每份都标明源文件，完整保留配置字段与实际参数；without_enable=true 的历史 without 文件现在自动跑两组，不再是仅跑关闭组；config/task.yaml 仅展示生效的 plugin_agent 块，其余未启用的历史块不复制。下表覆盖全部文件，不把模板与本机任务混为同一配置。

快照按 YAML 解析值归一化排版，注释、anchor 和格式不作为运行语义复制。明文 api_key 替换为环境变量名，其他凭据按需占位；max_tokens 等非凭据参数保持原值。复制配置后需要自行设置密钥，不能认为文档中含有原凭据。

所有相对路径仍以**源 YAML 所在目录**为基准，不能直接以本文档所在目录执行；移动文件时要同步调整路径。通用模板中的数据集、插件、模型、rubric、设备和工具链可能是占位，需要按实际任务补齐。验证器的字段说明见[字段参考](harmony-eval-config-reference.md)，声明了类型不代表已经完成真实设备或云测试验收。

| 文档位置 | YAML 源文件 | 用途 |
|---|---|---|
| 1.1 | [config/task.yaml](../config/task.yaml) | 默认实际任务，只展示活动 plugin_agent 块 |
| 2.1 | [config/task.multidev.yaml](../config/task.multidev.yaml) | 本机一多任务，直接评 Agent |
| 2.2 | [config/examples/task.library-skill.yaml](../config/examples/task.library-skill.yaml) | 三方库 Skill 通用模板，自动双组对照 |
| 2.3 | [config/task.library-plugin.with.yaml](../config/task.library-plugin.with.yaml) | 本机三方库 Plugin 加载组 |
| 2.4 | [config/examples/task.android-migration.yaml](../config/examples/task.android-migration.yaml) | Android 迁移通用模板 |
| 2.5 | [config/examples/task.opencode-agent.yaml](../config/examples/task.opencode-agent.yaml) | 指定 OpenCode Agent 通用模板 |
| 2.6 | [config/examples/task.mcp-harmonybot.yaml](../config/examples/task.mcp-harmonybot.yaml) | HarmonyBot 有无 MCP 通用模板 |
| 2.7 | [config/examples/task.mcp-opencode.yaml](../config/examples/task.mcp-opencode.yaml) | 独立 OpenCode 有无 MCP 通用模板 |
| 2.8 | [config/examples/task.knowledge-http.yaml](../config/examples/task.knowledge-http.yaml) | HTTP 智能问答通用模板 |
| 2.9 | [config/task.library-plugin.without.yaml](../config/task.library-plugin.without.yaml) | 三方库转换：自动 Plugin 有无对照 |
| 2.10 | [config/task.library-plugin.mcp.yaml](../config/task.library-plugin.mcp.yaml) | 三方库转换：固定 Plugin，比较有无 MCP |
| 2.11 | [config/task.api-upgrade.with.yaml](../config/task.api-upgrade.with.yaml) | API 升级：加载适配 Skill，使用 UITest 与云测试验收 |
| 2.12 | [config/task.api-upgrade.without.yaml](../config/task.api-upgrade.without.yaml) | API 升级：自动 Skill 有无对照 |
| 2.13 | [config/qa/huawei-mcp/with/task.yaml](../config/qa/huawei-mcp/with/task.yaml) | 共享 JSON 问答：独立 OpenCode 开启华为知识 MCP |
| 2.14 | [config/qa/huawei-mcp/without/task.yaml](../config/qa/huawei-mcp/without/task.yaml) | 共享 JSON 问答：独立 OpenCode 关闭华为知识 MCP |
| 2.15 | [config/qa/customer-service/task.yaml](../config/qa/customer-service/task.yaml) | 共享 JSON 问答：HTTP 智能客服本地桩 |
| 2.16 | [config/examples/task.library-plugin.yaml](../config/examples/task.library-plugin.yaml) | 三方库转换：通用 Plugin 模板 |
| 2.17 | [config/examples/task.multidev.yaml](../config/examples/task.multidev.yaml) | 一多适配：通用模板 |

入口统一为 `harmonyeval run <源 YAML 路径>`；可先加 --check 检查配置和能力准备。下面列出全量快照，而不是仅给差异字段；具体组别与任务状态仍以源文件为准。

### 2.1 一多适配：HarmonyBot 中指定一多 Agent

配置来源：`config/task.multidev.yaml`；相对路径以该文件所在目录解析。

数据集继续采用现有 base/PROMPT.md/metadata.json/test_patch.patch 等格式；本机读取 /Users/mayism/cases。该 YAML 已写入原 JSON 的工具链及 Pura 90 Pro、Mate X7、MatePad Pro 13 三台设备，使用独立插件 YAML 的 glm-5.3 模型，并完整展开已确认的 L1/L2/L3 评分；通用模板另见 2.17。生成时检查到一个有效 CaseBookRead 用例，metadata.case_id 为 bookread-template-derive-base；这属于配置预检结果，不代表已完成设备回归。

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

### 2.2 三方库转鸿蒙库：OpenCode 指定 Skill

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

### 2.3 三方库转鸿蒙库：OpenCode 装载指定 Plugin

配置来源：`config/task.library-plugin.with.yaml`；相对路径以该文件所在目录解析。

本例为实际加载组：without_enable: false，执行插件注册的 hmos-library-adapter-fast。目标插件已配置在独立 OpenCode 的 /Users/mayism/.config/opencode/plugins/hmos-library-adapter-fast。一键双组对照配置见 2.9；without_enable=true 自动生成 baseline build 和加载组 Agent，两组均用 glm-5.3。target.dir 保持一致以标识关闭的被测对象。

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

### 2.4 安卓应用转鸿蒙：HarmonyBot 中指定 d2h Agent

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

### 2.5 标准 OpenCode：直接指定一个 Agent

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

### 2.6 HarmonyBot 的 d2h Agent：通过 opencode.json 配置有无 MCP

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

若评真实安卓应用迁移，将 dataset.type 换成 android-migration，并使用 2.4 的工程验证与评分；MCP 仍然只在 OpenCode 配置中切换。

### 2.7 标准 OpenCode：通过 opencode.json 配置有无 MCP

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

### 2.8 智能问答：knowledge 配置请求 URL 后端的 Agent

配置来源：`config/examples/task.knowledge-http.yaml`；相对路径以该文件所在目录解析。

knowledge 表示智能问答，使用 HTTP 请求后端 Agent，与 2.6/2.7 中配置了 MCP 的本地 Agent 任务分别配置。本例为同步 JSON 协议，POST 问题后从 data.answer 取答案。后端生成模型由服务管理；verification.model 单独声明裁判模型。

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

### 2.9 三方库转换：自动 Plugin 有无对照

配置来源：[config/task.library-plugin.without.yaml](../config/task.library-plugin.without.yaml)；所有相对路径以该源 YAML 所在目录解析。

历史 without 文件名保留；该文件的 without_enable=true 现在表示一次自动执行两组：without 不加载目标插件并使用 build，with 加载插件并使用 hmos-library-adapter-fast。两组均用相同 glm-5.3 和判据，自动生成差值；无需再单独运行 2.3。Agent ID 的差异表示完整插件能力方案的对照。

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

### 2.10 三方库转换：固定 Plugin，比较有无 MCP

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

### 2.11 API 升级：加载适配 Skill，使用 UITest 与云测试验收

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

### 2.12 API 升级：自动 Skill 有无对照

配置来源：[config/task.api-upgrade.without.yaml](../config/task.api-upgrade.without.yaml)；所有相对路径以该源 YAML 所在目录解析。

历史 without 文件名保留；without_enable=true 一次自动跑 without+with，两组使用相同 build Agent、提示词、模型和 UITest/CloudTest 判据。只运行本文件即可，不要再重复运行 2.11。

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

### 2.13 共享 JSON 问答：独立 OpenCode 开启华为知识 MCP

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

### 2.14 共享 JSON 问答：独立 OpenCode 关闭华为知识 MCP

配置来源：[config/qa/huawei-mcp/without/task.yaml](../config/qa/huawei-mcp/without/task.yaml)；所有相对路径以该源 YAML 所在目录解析。

对应 2.13，使用同一份问题、标准答案、模型、build Agent 和裁判口径，改读 [opencode.without.json](../config/qa/huawei-mcp/opencode.without.json) 关闭目标 MCP。这里没有使用 without_enable；两组按实际 MCP 配置区分，不能根据 variants/with 目录名判断知识库是否启用。

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

### 2.15 共享 JSON 问答：HTTP 智能客服本地桩

配置来源：[config/qa/customer-service/task.yaml](../config/qa/customer-service/task.yaml)；所有相对路径以该源 YAML 所在目录解析。

与 2.13/2.14 共用 config/qa/data/cases.json；请求本地 http://127.0.0.1:18081/answer，发送 case_id 和 question，从 data.answer、data.session_id 提取结果。默认 ExactMatch+ImmediateValue 仅用于验证协议与评测链路，不调用裁判模型；其分数不能直接与 MCP 两组的语义评分比较。

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

### 2.16 三方库转换：通用 Plugin 模板

配置来源：[config/examples/task.library-plugin.yaml](../config/examples/task.library-plugin.yaml)；所有相对路径以该源 YAML 所在目录解析。

这是通用模板，区别于 2.3/2.9 的本机 hmos-library-adapter-fast 任务。当前模板是 without_enable=true、agent_name=build；插件路径、入口、用例、模型和 rubric 需要按实际插件补齐。Plugin 包名不能自动当作 Agent ID。

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

### 2.17 一多适配：通用模板

配置来源：[config/examples/task.multidev.yaml](../config/examples/task.multidev.yaml)；所有相对路径以该源 YAML 所在目录解析。

这是通用模板，区别于 2.1 中已配置本机 SDK 与三台设备的实际任务。复制后需要设置有效 HarmonyBot 来源、用例目录、设备/工具链和模型；不应把模板中的路径和设备占位当成本机可运行配置。

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
