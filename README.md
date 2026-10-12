# Multi-Device-Autorun

Autorun 使用 Python 3.9+ 批量运行 OpenCode Agent，用 Python 编排 HarmonyOS ohosTest、AGC 云测试、产物归档和报告。白盒评价的本地入口、远端任务服务、规则、Agent 调用、评分融合及报告由 Python 执行。ArkAnalyzer 作为可选的独立 Node 分析器保留，仅在 `HMOS_ARKANALYZER_ENABLE=true` 时调用。官方 Code Linter、OpenCode、DevEco/ohpm/Hvigor 和 H5 工程自身的工具链是外部工具。

## 安装与运行

### task.yaml 驱动的 HarmonyBot 评测

从 `develop` 的新入口可以用 `harmony-eval run <task.yaml>` 执行 `harmonybot_agent`，示例见
[`examples/harmonybot-agent/task.yaml`](examples/harmonybot-agent/task.yaml)。安装后若用户级 Python
脚本目录不在 `PATH`，也可运行 `python3 -m pyautorun.harmony_eval.cli run <task.yaml>`。

```bash
python3 -m pip install -e .
harmony-eval run examples/harmonybot-agent/task.yaml --check
harmony-eval run examples/harmonybot-agent/task.yaml
```

`dataset.dir` 指向现有 Autorun 用例目录，`target.dir` 指向 HarmonyOS Dev Assistant 扩展目录或其父目录。
`execution.agent_name` 是 `opencode.json` 的 Agent ID；`一多适配Agent` 也会映射为
`harmonyos-multi-device`。示例中的 `execution.model.provider_id` 和 `name` 沿用已安装 OpenCode
的 Provider 与模型。若需新增兼容 OpenAI API 的 Provider，可同时设置 `base_url` 和 `api_key`；
密钥推荐写环境变量名。模型配置会写入输出目录下的私有 OpenCode 资源快照，不修改已安装扩展。
`UITest.deveco_home` 派生
SDK、Hvigor、ohpm、HDC、模拟器路径，`devices` 不填时沿用 phone/foldable/tablet 三种默认设备。
云测试配置放在 `CloudTest` 节点，类别使用 AGC 数字 `test_categories`；白盒评价用 `Whitebox`
或 `LLM_judge`。云测试凭据可使用 `AGC_TEAM_ID`、`AGC_PROJECT_ID`、`AGC_AUTH_INFO` 环境变量。
需要签名时，在 `CloudTest.signingConfigs` 中配置材料路径；相对路径按 `task.yaml` 所在目录解析。
迁移的签名材料在 `src/cloud/signing/`；本机的 `src/cloud/agc-cookie.txt` 被 Git 忽略，
原文件为空，可以填入有效 cookie，或设置 `AGC_AUTH_INFO`。

`scoring` 中的 `name` 通过 [`src/harmony_eval/scoring.py`](src/harmony_eval/scoring.py) 的
`@register_scorer` 找到规则。当前临时规则为：`BooleanScoring` 读取 UITest JSON，所有实际执行的
设备测试均通过得 1，否则得 0；`WeightedSummation` 读取云测试 JSON 的设备与规则通过率，默认
各占 0.5；`ImmediateValue` 直接取白盒 JSON 的 `totalScore`。评分依赖落盘报告，缺报告时状态是
`unavailable`，不会按 0 分计。分数写入用例 `result.json`、批次 `summary.json`、`report.json`
和 HTML 报告。修改规则含义时应同时记录新的规则版本。

当前 `AGCDetection` 没有独立的原有执行器；`CloudTest.test_category` 的英文类别名也没有稳定的
AGC 数字映射，因此 YAML 会明确报错，需按现有云测试 API 填入数字类别。`without_enable`
在 `harmonybot_agent` 下尚无明确的“关闭 Agent 后怎样执行任务”的基线语义；当前只运行正常组并提示。

旧版 JSON 入口保留兼容，但不再提供仓库内置配置；使用时须显式传入外部 JSON 文件，
例如 `python3 -m pyautorun.cli --config /path/to/autorun.json --check`。
`npm run autorun -- --config /path/to/autorun.json` 使用同一旧版入口。
Windows 需安装 Python 3.9 或更高版本，命令中的 `python3` 可换为 `py -3`。
启用白盒评价或白盒 API，安装 `python3 -m pip install -e '.[whitebox]'`。
仅在开启 ArkAnalyzer 时需要在仓库根目录执行 `npm ci`；安装脚本会构建侧车。

除可选的白盒功能外，Python 运行层仅使用标准库。需要系统 Git；设备测试需要 DevEco Studio、SDK、HDC、ohpm 和 Hvigor；H5 用例另需其工程使用的 npm；HarmonyBot 来源需要已安装的 HarmonyOS Dev Assistant 扩展及该扩展提供的 OpenCode 资源和启动器。

根目录的 npm 快捷命令使用 `python3`，Windows 上只有该命令在 PATH 中可用时才适用；否则使用上面的 `py -3` 命令。

## 主要命令

| 操作 | 命令 |
| --- | --- |
| 环境检查 | `harmony-eval run <task.yaml> --check` |
| 批量执行 | `harmony-eval run <task.yaml>` |
| 旧版批量执行 | `python3 -m pyautorun.cli --config <autorun.json>` |
| 旧版重试失败批次 | `python3 -m pyautorun.cli --config <autorun.json> --retry <batchId> [--case <caseName>]` |
| 旧版合并历史报告 | `python3 -m pyautorun.cli --config <autorun.json> --merge [outputRoot]` |
| 独立云测试 | `python3 -m pyautorun.cli --config <autorun.json> --cloud-test --case <caseName>` 或 `--app <signed.app>` |
| 续查云测试 | `python3 -m pyautorun.cli --config <autorun.json> --poll-task <taskGroupId>` |
| 单用例 ohosTest | `python3 -m pyautorun.ohostest_case --case <caseDir> --out <outDir> --machine-config <machine.json> --run swe` |
| ohosTest Matrix | `python3 -m pyautorun.ohostest_matrix --project <projectDir> --machine-config <machine.json>` |
| 部署折叠触发脚本 | `python3 -m pyautorun.deploy_fold --project <projectDir> [--module entry] [--port 8765]` |
| 重新生成批次报告 | `python3 -m pyautorun.report_cli <batchRoot>` |
| 产物归档与上传 | `python3 -m pyautorun.upload_cli <batchRoot> --config <autorun.json>` |
| 向现有 OpenCode 发消息 | `python3 -m pyautorun.ask_opencode '你好' --port 61417` |
| 独立启动 OpenCode | `python3 -m pyautorun.serve_opencode --config <autorun.json>` |
| 本地白盒评价 | `python3 -m pyautorun.whitebox_local --input <input.json> [--port 62400]` |
| 远端白盒任务 | `python3 -m pyautorun.whitebox_remote --input <remote-task.json> [--case-root <dir>]` |
| 白盒 HTTP 服务 | `python3 -m pyautorun.whitebox_api --case-root <dir> [--host 0.0.0.0] [--port 3000]` |

`pip install -e .` 会将 `src/` 映射为 `pyautorun` 包，并安装 `harmony-eval` 和旧版 `autorun` 控制台命令。

## 配置与用例

主配置是评测任务的 `task.yaml`，示例见 `examples/harmonybot-agent/task.yaml`：

- `dataset.dir` 指向用例目录，`target.dir` 指向 HarmonyBot 扩展目录。
- `harmonybot_agent.execution` 设置 Agent、已有 Provider/模型和并发；新增 Provider 时，模型密钥推荐使用环境变量名。
- `harmonybot_agent.verification` 按 `type` 配置 UITest、CloudTest、Whitebox。UITest 的 `deveco_home` 派生其余 DevEco 路径。折叠屏开合脚本默认使用 `src/devices/fold-server.py`。
- `harmonybot_agent.scoring` 用 `name` 选择报告评分规则；`report.output_dir` 设置产物目录。

旧版 JSON 配置仍可作为外部文件通过 `--config` 传入旧版命令；仓库不再包含 `config/` 目录。

`execution.casesRoot` 下每个直接子目录是一个用例。可执行用例包含 `PROMPT.md` 和 `base/` 或 `task/`；如果 `metadata.platform` 为 `web`，还需同级 `web/`。Python 会复制工程到批次隔离目录，原始工程不被 Agent 修改。Agent 在 H5 用例中可同时看到 `base/` 与 `web/`，补丁路径以这两个目录的父目录为根。

启用 ohosTest 时，每个用例还需 `metadata.json`、`test_patch` 和 `golden_patch`；补丁和元数据仅在 Agent 结束后交给设备 Runner。Python Runner 支持 native、web、RN、Flutter、设备套件、bundle 隔离、设备类型兼容检查、折叠控制与 H5 端口转发。`pc`/`2in1` 用例按原逻辑跳过。

每个批次会写入 `summary.json`、`report.json` 和 `overview.html`，每个用例有独立状态、Agent 日志、补丁、设备/云测试结果和 HTML 详情页。失败用例可归档为 ZIP；配置 AGC 上传后会保存下载地址。

## 开发与验证

```bash
python3 -m compileall -q src
python3 -m unittest discover -s src/tests -q
npm test
```

`npm test` 运行 Python 回归测试并编译 ArkAnalyzer 侧车。完整白盒测试需要先安装 `.[whitebox]`，否则依赖额外库的测试会跳过。`src/` 通过打包配置映射为 `pyautorun` 包，下设 `orchestration/`（批次与用例）、`runtime/`（OpenCode）、`devices/`（ohosTest）、`cloud/`（AGC 云测试）、`reporting/`（报告与上传）和 `whitebox_eval/`（白盒规则、评分、服务及资源）；可选的 ArkAnalyzer 侧车位于 `whitebox_eval/ark_analyzer/`。根目录保留旧命令的兼容入口。
