# HarmonyEval

基于 EvalScope 1.14.x 的通用评测框架，支持一多适配、三方库转鸿蒙库、安卓应用转鸿蒙、MCP 对照和 HTTP 智能问答。任务统一由 YAML 驱动：

```sh
harmonyeval run ./scenarios/library-migration/task.default.yaml
```

原 JSON 批量执行入口已移除。模型、用例、执行环境、评估流程和评分规则统一配置在 task YAML 中。

## 安装

建议使用 Python 3.12，运行框架最低要求 Python 3.10。macOS/Linux：

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[eval]'
```

Windows PowerShell：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e '.[eval]'
```

从旧版本升级时先运行 `python -m pip uninstall -y multi-device-autorun-python`，再执行安装命令以刷新控制台入口。主命令和 Python 包名现统一为 `harmonyeval`，源码直接位于根目录 harmonyeval/。OpenCode、HarmonyBot、DevEco/SDK/HDC、ohpm/Hvigor、Flutter SDK 等按所测场景配置；不是每种任务都要求所有工具。云测试另需实际 AGC 认证、签名和设备资源。

## 主要命令

| 操作 | 命令 |
|---|---|
| 展示任务计划 | `harmonyeval plan ./scenarios/library-migration/task.default.yaml` |
| 配置与实际能力装载检查 | `harmonyeval run ./scenarios/library-migration/task.default.yaml --check` |
| 执行任务 | `harmonyeval run ./scenarios/library-migration/task.default.yaml` |
| 使用已有工程/答案重新评估 | `harmonyeval verify ./scenarios/library-migration/task.default.yaml --run <单组运行目录>` |
| 使用已有验证指标重新评分 | `harmonyeval rescore ./scenarios/library-migration/task.default.yaml --run <单组运行目录>` |
| 两组对比，差值为右组减左组 | `harmonyeval compare <左组目录> <右组目录> --output <对比目录>` |

也可用同一环境的 `python -m harmonyeval run ./scenarios/library-migration/task.default.yaml`或 `python -m harmonyeval.cli run ./scenarios/library-migration/task.default.yaml`，它们都进入相同的 Harmony Eval CLI。npm 快捷命令为 `npm run harmonyeval -- run ./scenarios/library-migration/task.default.yaml`；该脚本使用 PATH 中的 python3，需先激活评测环境。

`--check` 不请求生成模型，检查通过不证明密钥已获服务授权、MCP 已连通或设备测试成功。实际执行会保留错误和缺失证据，不将 unavailable 自动计为零分或满分。

## 场景配置

任务 YAML 统一放在 `scenarios/<scenario>/`，子目录与 YAML 的 scenario 字段一致。`*.example.yaml` 是需要替换路径的通用模板；JSON、评分说明和认证等配套资源仍放在 config/。CLI 直接接收所选 YAML 路径，不依赖固定目录。

| 场景 | 配置 |
|---|---|
| 默认任务 | [scenarios/library-migration/task.default.yaml](scenarios/library-migration/task.default.yaml)，当前选择本机 thirdcase 的插件评测 |
| 一多适配 | [multi-dev/task.yaml](scenarios/multi-dev/task.yaml) |
| 三方库单组/一键有无插件对照 | [library-migration/task.plugin.yaml](scenarios/library-migration/task.plugin.yaml)，用 without_enable 切换 |
| 三方库插件固定，有/无 MCP | [library-migration/task.plugin-mcp.yaml](scenarios/library-migration/task.plugin-mcp.yaml)，一次执行两组并自动比较 |
| API 升级单组/一键有无 Skill 对照 | [api-upgrade/task.yaml](scenarios/api-upgrade/task.yaml)，用 without_enable 切换 |
| 知识问答有/无 MCP、智能客服 URL | [问答任务说明](scenarios/knowledge-eval/README.md)，统一读取 [data/cases.json](scenarios/knowledge-eval/data/cases.json) |
| 各类型通用模板 | [scenarios](scenarios) |

`dataset` 选择用例适配器，`target.type` 决定同名的活动目标块；该块定义 `execution`、`verification`、`scoring` 和 `report`。`execution.enviroment` 配置 deveco_home、flutter_home、java_home、sdk_home。UITest、CloudTest 和白盒均在 verification 中声明，评分器通过 source 引用其指标。

被测 Plugin 由 target.dir 装载，Agent 由 execution.agent_name 指定。Skill/Plugin 的 without_enable=true 表示一次任务先跑不加载对象的 without 组，再跑加载的 with 组并自动比较；false/省略只跑 with。Plugin 的 without 组默认使用 build，可用 without_agent_name 指定其他宿主 Agent。MCP 完整定义来自 OpenCode JSON，顶层 experiments 只覆盖指定服务器的 enabled；各组保留相同的能力、Agent、模型、用例和评分。密钥使用环境变量名，不提交真实凭据。

一多用例保留 base/或task/、PROMPT.md、metadata.json、test_patch.patch 和 golden_patch.patch；迁移类用例支持 case.yaml 或仓库目录；文本类使用 JSON/JSONL。用例准备、执行、评估和评分使用独立适配器，新增验证器和评分器可通过 Python entry points 注册。

## 产物

单组结果位于 `report.output_dir/<run_id>/`，包含 task-report.json、index.html、脱敏任务快照、EvalScope 产物，以及 `variants/<组名>/round-XX/cases/<用例ID>/` 下的工程、change.patch、generate/agent-output.json/html/events.jsonl/stderr.jsonl 和 verification 证据。一多的 metadata 和 golden/test 补丁在 Agent 结束后归档；UITest 结果位于 verification/<验证器ID>/。

启用 without_enable 或配置 MCP experiments 时，批次根目录生成 experiments-report.json 和 index.html，各组位于 experiments/<ID>/，对比位于 comparisons/<后续组ID>/；第一组为基准。verify/rescore/compare 指向单组子目录。评分平均值只使用有效证据，并展示覆盖率。

运行配置、数据库和可清理的评估副本放在系统临时目录。隔离工作目录不是操作系统文件访问沙箱。

## 开发与验证

开发新场景或扩展用例集、验证器、评分器时，先使用仓库内的 [harmonyeval Skill](.agents/skills/harmonyeval/SKILL.md)。[AGENTS.md](AGENTS.md) 为代码 Agent 提供统一入口；可显式要求“使用 `$harmonyeval` 新增评测场景”。Skill 包含扩展接口、证据与评分协议、架构边界和自验证要求，并随代码一起维护。

```sh
python -m compileall -q harmonyeval tests
python -m unittest discover -s tests -q
```

真实 OpenCode + 本地模型/MCP 的可选集成验证：

```sh
HARMONY_EVAL_INTEGRATION=1 python -m unittest discover -s tests -p test_harmony_eval_opencode.py
```

共用的设备 Runner、云测试客户端/轮询、白盒工具和历史产物维护代码仍保留；它们不再通过旧 JSON 批量入口启动。可选 ArkAnalyzer 侧车位于 harmonyeval/integrations/whitebox/ark_analyzer，需要时运行 `npm ci`、`npm run build:whitebox`；当前 Harmony Eval 的 whiteboxeval 是模型评价，不等于完整 ArkAnalyzer 流程。

docs 维护三份文档：[框架设计与重构指南](docs/harmony-eval-framework-design.md)（架构、迁移、EvalScope和扩展开发）、[YAML 配置说明与场景示例](docs/harmony-eval-task-examples.md)（安装运行、字段枚举、对照配置和15份完整任务）、[适配器设计与实现说明](docs/harmony-eval-adapter-implementation.md)（用例转换、执行、验证、评分及静态评估的源码调用关系）。
