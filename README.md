# Multi-Device-Autorun

Autorun 使用 Python 3.9+ 批量运行 OpenCode Agent，用 Python 编排 HarmonyOS ohosTest、AGC 云测试、产物归档和报告。白盒评价的本地入口、远端任务服务、规则、Agent 调用、评分融合及报告由 Python 执行。ArkAnalyzer 作为可选的独立 Node 分析器保留，仅在 `HMOS_ARKANALYZER_ENABLE=true` 时调用。官方 Code Linter、OpenCode、DevEco/ohpm/Hvigor 和 H5 工程自身的工具链是外部工具。

## 安装与运行

在仓库根目录执行：

```bash
python3 -m pip install -e .
python3 -m pyautorun.cli --check --config config/autorun.config.json
python3 -m pyautorun.cli --config config/autorun.config.json
```

也可运行 `npm run autorun -- --check` 或 `npm run autorun`；这些命令调用同一个 Python 入口。启用白盒评价或白盒 API，安装 `python3 -m pip install -e '.[whitebox]'`。仅在开启 ArkAnalyzer 时需要在仓库根目录执行 `npm ci`；安装脚本会构建侧车。

除可选的白盒功能外，Python 运行层仅使用标准库。需要系统 Git；设备测试需要 DevEco Studio、SDK、HDC、ohpm 和 Hvigor；H5 用例另需其工程使用的 npm；HarmonyBot 来源需要已安装的 HarmonyOS Dev Assistant 扩展及该扩展提供的 OpenCode 资源和启动器。

Windows 终端可将示例里的 `python3` 换成 `py -3` 或实际 Python 3 可执行文件；根目录的 npm 快捷命令使用 `python3`，需该命令在 PATH 中可用。

## 主要命令

| 操作 | 命令 |
| --- | --- |
| 环境检查 | `python3 -m pyautorun.cli --check` |
| 批量执行 | `python3 -m pyautorun.cli` |
| 重试失败批次 | `python3 -m pyautorun.cli --retry <batchId> [--case <caseName>]` |
| 合并历史报告 | `python3 -m pyautorun.cli --merge [outputRoot]` |
| 独立云测试 | `python3 -m pyautorun.cli --cloud-test --case <caseName>` 或 `--app <signed.app>` |
| 续查云测试 | `python3 -m pyautorun.cli --poll-task <taskGroupId>` |
| 单用例 ohosTest | `python3 -m pyautorun.ohostest_case --case <caseDir> --out <outDir> --machine-config <machine.json> --run swe` |
| ohosTest Matrix | `python3 -m pyautorun.ohostest_matrix --project <projectDir> --machine-config <machine.json>` |
| 部署折叠触发脚本 | `python3 -m pyautorun.deploy_fold --project <projectDir> [--module entry] [--port 8765]` |
| 重新生成批次报告 | `python3 -m pyautorun.report_cli <batchRoot>` |
| 产物归档与上传 | `python3 -m pyautorun.upload_cli <batchRoot> [--config config/autorun.config.json]` |
| 向现有 OpenCode 发消息 | `python3 -m pyautorun.ask_opencode '你好' --port 61417` |
| 独立启动 OpenCode | `python3 -m pyautorun.serve_opencode --config config/autorun.config.json` |
| 本地白盒评价 | `python3 -m pyautorun.whitebox_local --input <input.json> [--port 62400]` |
| 远端白盒任务 | `python3 -m pyautorun.whitebox_remote --input <remote-task.json> [--case-root <dir>]` |
| 白盒 HTTP 服务 | `python3 -m pyautorun.whitebox_api --case-root <dir> [--host 0.0.0.0] [--port 3000]` |

所有 Autorun 命令可用 `--config` 指定另一份 JSON 配置。`pip install -e .` 会安装同名的 Python 控制台命令，并让 `python3 -m pyautorun.*` 在仓库根目录可用。

## 配置与用例

主配置为 `config/autorun.config.json`，核心字段包括：

- `server.opencodeSource`：`harmonyBot` 或 `softwareEngineering` 来源；也支持 `targets` 数组进行多 Agent 对比。
- `server.url`、`server.runtimeRoot`、`server.devecoHome`：OpenCode 地址、私有运行目录和 DevEco 安装目录。
- `execution.casesRoot`、`execution.outputRoot`、`execution.agent`、`execution.providerId`、`execution.model`、`execution.concurrency`：用例、产物、模型与并发。
- `ohosTest`：启用设备验证时设置 `paths`、`devices` 和 `timeoutSec`。本机的 HDC、模拟器、Hvigor 路径放在配置中，勿提交本机凭据。
- `cloudTest`：AGC 云测试设置。未启用时不提交任务；独立提交和续查可使用上表命令。
- `whiteboxEvaluation`：启用时使用 Python 白盒入口；开启 `HMOS_ARKANALYZER_ENABLE=true` 时另需构建 ArkAnalyzer sidecar。
- `upload`：默认关闭。启用时提供 `projectId`、`clientId`、`clientSecret`、`bucketName`，也可通过 `AGC_UPLOAD_PROJECT_ID`、`AGC_UPLOAD_CLIENT_ID`、`AGC_UPLOAD_CLIENT_SECRET`、`AGC_UPLOAD_BUCKET` 环境变量提供。不要把凭据提交到 Git。

`execution.casesRoot` 下每个直接子目录是一个用例。可执行用例包含 `PROMPT.md` 和 `base/` 或 `task/`；如果 `metadata.platform` 为 `web`，还需同级 `web/`。Python 会复制工程到批次隔离目录，原始工程不被 Agent 修改。Agent 在 H5 用例中可同时看到 `base/` 与 `web/`，补丁路径以这两个目录的父目录为根。

启用 ohosTest 时，每个用例还需 `metadata.json`、`test_patch` 和 `golden_patch`；补丁和元数据仅在 Agent 结束后交给设备 Runner。Python Runner 支持 native、web、RN、Flutter、设备套件、bundle 隔离、设备类型兼容检查、折叠控制与 H5 端口转发。`pc`/`2in1` 用例按原逻辑跳过。

每个批次会写入 `summary.json`、`report.json` 和 `overview.html`，每个用例有独立状态、Agent 日志、补丁、设备/云测试结果和 HTML 详情页。失败用例可归档为 ZIP；配置 AGC 上传后会保存下载地址。

## 开发与验证

```bash
python3 -m compileall -q src/pyautorun
python3 -m unittest discover -s src/pyautorun/tests -q
npm test
```

`npm test` 运行 Python 回归测试并编译 ArkAnalyzer 侧车。完整白盒测试需要先安装 `.[whitebox]`，否则依赖额外库的测试会跳过。`src/pyautorun/` 下按功能分为 `orchestration/`（批次与用例）、`runtime/`（OpenCode）、`devices/`（ohosTest）、`cloud/`（AGC 云测试）、`reporting/`（报告与上传）和 `whitebox_eval/`（白盒规则、评分、服务及资源）；可选的 ArkAnalyzer 侧车位于 `whitebox_eval/ark_analyzer/`。根目录保留旧命令的兼容入口。
