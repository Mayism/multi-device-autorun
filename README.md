# Multi-Device-Autorun

Autorun 使用 Python 3.9+ 批量运行 OpenCode Agent，用 Python 编排 HarmonyOS ohosTest、AGC 云测试、产物归档和报告。白盒评价的本地入口、远端任务服务、规则、Agent 调用、评分融合及报告由 Python 执行。ArkAnalyzer 作为可选的独立 Node 分析器保留，仅在 `HMOS_ARKANALYZER_ENABLE=true` 时调用。官方 Code Linter、OpenCode、DevEco/ohpm/Hvigor 和 H5 工程自身的工具链是外部工具。

## 安装与运行

macOS/Linux 在仓库根目录执行：

```bash
python3 -m pip install -e .
python3 -m pyautorun.cli --check
python3 -m pyautorun.cli
```

Windows（PowerShell 或 CMD）在仓库根目录执行：

```powershell
py -3 -m pip install -e .
py -3 -m pyautorun.cli --check
py -3 -m pyautorun.cli
```

Windows 需安装 Python 3.9 或更高版本。如果没有 `py` 启动器，可将上述 `py -3` 换成已加入 PATH 的 `python`。

`python3 -m pyautorun.cli` 会运行 `pyautorun` 包中的 CLI 模块：`src/cli.py` 是兼容入口，实际命令处理在 `src/orchestration/cli.py`。从仓库根目录启动时，默认读取 `./config/autorun.config.json`，无需重复指定 `--config`；如果从其他工作目录启动，或要使用另一份配置，请传入 `--config <配置文件路径>`。

也可运行 `npm run autorun -- --check` 或 `npm run autorun`；这些命令调用同一个 Python 入口。启用白盒评价或白盒 API，安装 `python3 -m pip install -e '.[whitebox]'`。仅在开启 ArkAnalyzer 时需要在仓库根目录执行 `npm ci`；安装脚本会构建侧车。

除可选的白盒功能外，Python 运行层仅使用标准库。需要系统 Git；设备测试需要 DevEco Studio、SDK、HDC、ohpm 和 Hvigor；H5 用例另需其工程使用的 npm；HarmonyBot 来源需要已安装的 HarmonyOS Dev Assistant 扩展及该扩展提供的 OpenCode 资源和启动器。

根目录的 npm 快捷命令使用 `python3`，Windows 上只有该命令在 PATH 中可用时才适用；否则使用上面的 `py -3` 命令。

## 主要命令

| 操作 | 命令 |
| --- | --- |
| 环境检查 | `python3 -m pyautorun.cli --check` |
| 批量执行 | `python3 -m pyautorun.cli` |
| 合并历史报告 | `python3 -m pyautorun.cli --merge [outputRoot]` |
| 仅生成 L1 评分报告 | `python3 -m pyautorun.cli --l1 [batchId或目录]`（缺省取 outputRoot 下最新批次，也可指向单个 Agent 目标目录；批次结束后也会自动生成） |
| 独立云测试 | `python3 -m pyautorun.cli --cloud-test --case <caseName>` 或 `--app <signed.app>` |
| 续查云测试 | `python3 -m pyautorun.cli --poll-task <taskGroupId>` |
| 单用例 ohosTest | `python3 -m pyautorun.ohostest_case --case <caseDir> --out <outDir> --machine-config <machine.json> --run swe` |
| ohosTest Matrix | `python3 -m pyautorun.ohostest_matrix --project <projectDir> --machine-config <machine.json>` |
| 部署折叠触发脚本 | `python3 -m pyautorun.deploy_fold --project <projectDir> [--module entry] [--port 8765]` |
| 重新生成批次报告 | `python3 -m pyautorun.report_cli <batchRoot>` |
| 重新打包本地用例产物 | `python3 -m pyautorun.archive_cli <batchRoot>` |
| 向现有 OpenCode 发消息 | `python3 -m pyautorun.ask_opencode '你好' --port 61417` |
| 独立启动 OpenCode | `python3 -m pyautorun.serve_opencode --config config/autorun.config.json` |
| 本地白盒评价 | `python3 -m pyautorun.whitebox_local --input <input.json> [--port 62400]` |
| 远端白盒任务 | `python3 -m pyautorun.whitebox_remote --input <remote-task.json> [--case-root <dir>]` |
| 白盒 HTTP 服务 | `python3 -m pyautorun.whitebox_api --case-root <dir> [--host 0.0.0.0] [--port 3000]` |

`pip install -e .` 会将 `src/` 映射为 `pyautorun` 包，并安装 `autorun` 控制台命令；上面的 `python3 -m pyautorun.cli` 与它运行同一入口。

## 配置与用例

主配置为 `config/autorun.config.json`，核心字段包括：

- `server.opencodeSource`：`harmonyBot` 或 `softwareEngineering` 来源；也支持 `targets` 数组进行多 Agent 对比。
- `server.url`、`server.runtimeRoot`、`server.devecoHome`：OpenCode 地址、私有运行目录和 DevEco 安装目录。
- `execution.casesRoot`、`execution.outputRoot`、`execution.agent`、`execution.providerId`、`execution.model`、`execution.concurrency`：用例、产物、模型与并发。
- `ohosTest`：启用设备验证时设置 `paths`、`devices` 和 `timeoutSec`。本机的 HDC、模拟器、Hvigor 路径放在配置中，勿提交本机凭据。折叠屏开合脚本默认使用 `src/devices/fold-server.py`，无需配置 `paths.foldServerScript`；旧 `src/ohostest/src/fold/assets/fold-server.py` 路径会自动映射到新位置。RN 用例可设置 `rnWorkRoot` 使用短路径运行；Windows 默认使用 `D:\rn`，设置为 `false` 可关闭。运行结束后仅将测试结果迁回用例目录，临时构建 work 会清理。
- `cloudTest`：AGC 云测试设置。未启用时不提交任务；独立提交和续查可使用上表命令。
- `whiteboxEvaluation`：启用时使用 Python 白盒入口；开启 `HMOS_ARKANALYZER_ENABLE=true` 时另需构建 ArkAnalyzer sidecar。

`execution.casesRoot` 下每个直接子目录是一个用例。可执行用例包含 `PROMPT.md` 和 `base/` 或 `task/`；如果 `metadata.platform` 为 `web`，还需同级 `web/`。Python 会复制工程到批次隔离目录，原始工程不被 Agent 修改。Agent 在 H5 用例中可同时看到 `base/` 与 `web/`，补丁路径以这两个目录的父目录为根。

启用 ohosTest 时，每个用例还需 `metadata.json`、`test_patch` 和 `golden_patch`；补丁和元数据仅在 Agent 结束后交给设备 Runner。Python Runner 支持 native、web、RN、Flutter、设备套件、bundle 隔离、设备类型兼容检查、折叠控制与 H5 端口转发。`pc`/`2in1` 用例按原逻辑跳过。

Agent 变更补丁从净化后的 Git 暂存区生成，过滤编译缓存与构建文件；DevEco 将 `BuildProfile.ets` 的构建模式由 `test` 改为 `debug` 时会还原这一项，同时保留 Agent 对该文件的其他修改。自动确认可续跑普通流程询问和图片能力不足时的基础测试降级；效果验收与需要用户输入的询问仍等待人工回答。设备验证用到的 `golden_patch` 会保留在用例产物中。

每个批次会写入 `summary.json`、`report.json` 和 `overview.html`。`summary.json.environment` 保存来源、模型、运行时与 Skill 信息，`summary.json.results` 保存各用例最终结果。`batch.json`、`batch.pid` 仅在运行期间保留；用例目录顶层的 `result.json`、`state.json`、`session.json` 在 `summary.json` 成功落盘后清理。`generate/input.txt`、`last-message.json`、`skill-runtime.json`、`output.txt`、`final-message.json` 不再生成，Agent 最终文本保留在 `summary.json.results[].output`。

每个用例的 `generate/agent-output.html` 是可搜索、按消息类型筛选的离线执行轨迹，由 `all-messages.json` 生成，包含主/子 Session 的消息和工具调用。页面显示时分秒格式的 Agent 耗时与千位 `k` 格式的总 Token；同目录保留 `agent-output.log`。每个已有用例目录会自动生成本地 ZIP，排除上述运行期文件及可再生成的构建缓存。ohosTest Runner 自己的 `result.json` 等测试结果仍保留在 `.ohostest-runs/`。批次结束后另生成 L1 评分报告（`l1-report/index.html` 与 `l1.json`），也可用 `--l1` 从既有批次产物离线重新生成。

## 开发与验证

```bash
python3 -m compileall -q src
python3 -m unittest discover -s src/tests -q
npm test
```

`npm test` 运行 Python 回归测试并编译 ArkAnalyzer 侧车。完整白盒测试需要先安装 `.[whitebox]`，否则依赖额外库的测试会跳过。`src/` 通过打包配置映射为 `pyautorun` 包，下设 `orchestration/`（批次与用例）、`runtime/`（OpenCode）、`devices/`（ohosTest）、`cloud/`（AGC 云测试）、`reporting/`（报告与本地归档）和 `whitebox_eval/`（白盒规则、评分、服务及资源）；可选的 ArkAnalyzer 侧车位于 `whitebox_eval/ark_analyzer/`。根目录保留旧命令的兼容入口。
