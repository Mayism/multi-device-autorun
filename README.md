# Multi-Device-Autorun

Autorun 使用 Python 3.9+ 批量运行 OpenCode Agent，用 Python 编排 HarmonyOS ohosTest、AGC 云测试、产物归档和报告。白盒评价保留现有 TypeScript/Node 实现，由 Python 调用其编译后的 CLI。HarmonyBot 插件自带的 JavaScript 启动器、DevEco/ohpm/Hvigor、H5 工程自身的 npm 工具链属于外部工具，不是 Autorun 的 Node 运行模块。

## 安装与运行

在仓库根目录执行：

```bash
python3 -m pyautorun.cli --check --config config/autorun.config.json
python3 -m pyautorun.cli --config config/autorun.config.json
```

也可运行 `npm run autorun -- --check` 或 `npm run autorun`；这些命令现在调用同一个 Python 入口。只使用 Agent、设备和云测试时无需安装仓库的 npm 依赖。启用白盒评价前执行 `npm install` 和 `npm run build:whitebox`。

Python 运行层仅使用标准库。需要系统 Git；设备测试需要 DevEco Studio、SDK、HDC、ohpm 和 Hvigor；H5 用例另需其工程使用的 npm；HarmonyBot 来源需要已安装的 HarmonyOS Dev Assistant 扩展及该扩展提供的 OpenCode 资源和启动器。

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

所有 Autorun 命令可用 `--config` 指定另一份 JSON 配置。`pip install -e .` 会安装同名的 Python 控制台命令；直接用 `python3 -m` 不需要安装包。

## 配置与用例

主配置为 `config/autorun.config.json`，核心字段包括：

- `server.opencodeSource`：`harmonyBot` 或 `softwareEngineering` 来源；也支持 `targets` 数组进行多 Agent 对比。
- `server.url`、`server.runtimeRoot`、`server.devecoHome`：OpenCode 地址、私有运行目录和 DevEco 安装目录。
- `execution.casesRoot`、`execution.outputRoot`、`execution.agent`、`execution.providerId`、`execution.model`、`execution.concurrency`：用例、产物、模型与并发。
- `ohosTest`：启用设备验证时设置 `paths`、`devices` 和 `timeoutSec`。本机的 HDC、模拟器、Hvigor 路径放在配置中，勿提交本机凭据。
- `cloudTest`：AGC 云测试设置。未启用时不提交任务；独立提交和续查可使用上表命令。
- `whiteboxEvaluation`：启用时需要构建 `src/whitebox/dist/localCli.js`。
- `upload`：默认关闭。启用时提供 `projectId`、`clientId`、`clientSecret`、`bucketName`，也可通过 `AGC_UPLOAD_PROJECT_ID`、`AGC_UPLOAD_CLIENT_ID`、`AGC_UPLOAD_CLIENT_SECRET`、`AGC_UPLOAD_BUCKET` 环境变量提供。不要把凭据提交到 Git。

`execution.casesRoot` 下每个直接子目录是一个用例。可执行用例包含 `PROMPT.md` 和 `base/` 或 `task/`；如果 `metadata.platform` 为 `web`，还需同级 `web/`。Python 会复制工程到批次隔离目录，原始工程不被 Agent 修改。Agent 在 H5 用例中可同时看到 `base/` 与 `web/`，补丁路径以这两个目录的父目录为根。

启用 ohosTest 时，每个用例还需 `metadata.json`、`test_patch` 和 `golden_patch`；补丁和元数据仅在 Agent 结束后交给设备 Runner。Python Runner 支持 native、web、RN、Flutter、设备套件、bundle 隔离、设备类型兼容检查、折叠控制与 H5 端口转发。`pc`/`2in1` 用例按原逻辑跳过。

每个批次会写入 `summary.json`、`report.json` 和 `overview.html`，每个用例有独立状态、Agent 日志、补丁、设备/云测试结果和 HTML 详情页。失败用例可归档为 ZIP；配置 AGC 上传后会保存下载地址。

## 开发与验证

```bash
python3 -m compileall -q pyautorun
python3 -m unittest discover -s pyautorun/tests -q
npm test
```

`npm test` 运行 Python 回归测试和保留的白盒 TypeScript 测试。`src/ohostest/` 仅保存旧版发布记录与设计文档；活跃 ohosTest 代码在 `pyautorun/`。白盒源码及其 npm 依赖在 `src/whitebox/`。
