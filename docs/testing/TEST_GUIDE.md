# Autorun 测试环境与执行指南

本文面向拿到工程后进行功能验证的测试人员，目标是完成一次从环境预检、Agent 生成，到 ohosTest、云测试、白盒评价和总览报告检查的完整测试。

## 1. 测试范围

一次正式任务包含以下模块：

1. **Agent 运行**：读取用例的 `PROMPT.md`，修改复制到输出目录的工程并记录生成过程。
2. **ohosTest**：在本地模拟器上编译、安装并执行适配测试。
3. **云测试**：构建 release 签名包，上传 AGC 并执行远端真机测试。
4. **白盒评价**：使用单独配置的裁判模型，结合原始 Prompt、工程改动和 Agent 编译记录生成评价报告。
5. **报告汇总**：生成批次级 `overview.html`，展示各模块总览，并提供云测试、白盒评价详细报告入口。

Agent 阶段结束后，ohosTest、云测试和白盒评价由各自分支执行。某一分支失败时，其他已经启动的分支仍应继续并记录自己的结果。

## 2. 测试 PC 环境

### 2.1 必备软件

| 软件或资源 | 要求 | 验证方式 |
| --- | --- | --- |
| 操作系统 | 推荐 Windows 10/11 64 位 | `winver` |
| Node.js | 22.5.0 或更高版本；白盒评价依赖该版本开始提供的 `node:sqlite` `DatabaseSync` | `node --version` |
| npm | 随 Node.js 安装 | `npm --version` |
| Git | 命令行可用 | `git --version` |
| Python 3 | fold-server 等测试辅助能力需要 | `python --version` |
| DevEco Studio | 安装用例所需 HarmonyOS SDK、Node、ohpm、hvigor、hdc 和 Emulator | 在 DevEco Studio 的 SDK Manager 中检查 |
| OpenCode 来源 | HarmonyBot VS Code 扩展，或 softwareEngineering 资源包 | 见 3.2 节 |
| 模型服务 | Agent 模型和白盒裁判模型均可访问 | `node autorun.mjs --check` |
| 网络 | 可访问模型 Provider；启用云测试时还需访问 AGC | 预检和正式任务验证 |

当前开发机已验证的基础版本为 Node.js `v24.14.0`、npm `11.9.0`、Git `2.53.0.windows.2`、Python `3.12.10`。测试机可以使用其他兼容版本，但出现环境差异问题时，应优先用上述版本复现。

同时运行多个 Agent 和本地模拟器会占用较多内存与磁盘。建议使用 32 GB 或更多内存，并预留至少 50 GB 可用磁盘空间；这是测试机建议值，不是程序启动的硬限制。

### 2.2 测试资料

测试前需要准备：

- 本工程的完整代码和根目录 `package-lock.json`；
- 至少一个符合格式的用例目录；
- 可用的 Agent 模型与裁判模型 Provider 配置；
- 与 `ohosTest.devices` 对应的本地模拟器镜像和 Profile；
- 启用云测试时所需的 AGC 团队/项目权限、登录 Cookie 和签名材料。

API Key、Cookie、证书密码等敏感信息应通过团队认可的安全渠道单独交付，不要写入测试文档、缺陷单、截图或提交到 Git。

## 3. 首次安装与配置

### 3.1 安装依赖并构建

在工程根目录打开 PowerShell、CMD 或 Git Bash，执行：

```bash
npm ci
npm run build
```

`npm ci` 按根目录 `package-lock.json` 安装一次全部依赖。`packages/runner` 和 `packages/whitebox-evaluation` 是 npm workspace，无需进入子目录重复安装。

预期结果：两个 workspace 均构建成功，命令退出码为 0。

### 3.2 配置 OpenCode 来源

编辑 `config/autorun.config.json`：

- `server.opencodeSource.mode`：
  - `harmonyBot`：使用 HarmonyBot VS Code 扩展中的 `resources/opencode`；
  - `softwareEngineering`：使用指定资源包中的 `resources/opencode`。
- `server.opencodeSource.root`：填写 VS Code 扩展根目录或 softwareEngineering 资源包根目录。
- `server.devecoHome`：填写 DevEco Studio 安装目录。未配置时程序会尝试读取 `DEVECO_HOME` 环境变量；两者都没有时，DevEco 相关功能无法正常执行。
- `server.node`：显式填写 DevEco Studio 自带的 `tools/node/node.exe`，版本必须不低于 22.5.0。
- `server.sdkHome`：显式填写 DevEco Studio 的 `sdk` 目录。
- `server.javaHome`：显式填写 DevEco Studio 自带的 `jbr` 目录，不要填写到 `jbr/bin`。
- `server.hvigorw`：显式填写 `tools/hvigor/bin/hvigorw.js`；程序会使用 `server.node` 执行它。
- `server.ohpm`：显式填写 `tools/ohpm/bin/ohpm.bat`（Windows）或对应平台的 ohpm 可执行文件。

使用 `harmonyBot` 时，扩展目录中需要安装名称前缀为 `huaweideveloperserviceplatform.harmonyosdevassistantforvscode` 的扩展。当前开发机使用过 `0.1.65`，测试时优先使用项目组指定版本。

最终选中的 `resources/opencode` 中必须有当前平台对应的 OpenCode 可执行文件、`opencode.json` 和 `skills/`。Agent 与模型配置由该目录下的 `opencode.json` 提供。

### 3.3 配置用例、Agent 和模型

重点检查 `config/autorun.config.json` 中的以下字段：

| 配置项 | 作用 |
| --- | --- |
| `execution.casesRoot` | 测试用例根目录，例如 `D:\\cases` |
| `execution.agent` | 本次生成使用的 Agent 名称 |
| `execution.model` | Agent 使用的模型，格式通常为 `provider/model` |
| `execution.concurrency` | 同时运行的 Agent 用例数 |
| `execution.additionalPrompt` | 可选；向每个用例 `PROMPT.md` 追加统一提示词 |
| `whiteboxEvaluation.enabled` | 是否启用白盒评价；未配置时使用代码默认值 |
| `whiteboxEvaluation.judge.providerId` | 裁判模型 Provider 名称，需能在 `opencode.json` 中匹配 |
| `whiteboxEvaluation.judge.modelId` | 裁判模型 ID，可与 Agent 生成模型不同 |

不要在 `autorun.config.json` 中重复配置 Provider 的 URL 或 API Key。白盒评价会按 `providerId` 从当前 OpenCode 来源的 `opencode.json` 中匹配模型能力。

### 3.4 配置本地模拟器

测试机应显式配置工具路径，不依赖系统 `PATH`。重点检查：

- `ohosTest.paths.hdc`：HarmonyOS SDK `toolchains` 目录下的 `hdc.exe`；
- `ohosTest.paths.emulatorBin`：`Emulator.exe` 所在目录；
- `ohosTest.paths.emulatorDeployedDir`：模拟器镜像部署目录；
- `ohosTest.devices[].profile`：本机实际存在的模拟器 Profile 名称；
- `ohosTest.devices[].target` 和 `hdcPort`：各设备之间不能冲突；
- `ohosTest.devices[].startEmulator`：是否由 Runner 自动启动模拟器。

可用配置中的模拟器程序查看本机 Profile，例如：

```powershell
& "D:\deveco\DevEco Studio\tools\emulator\Emulator.exe" -list -details
```

路径仅为示例，应替换为测试机实际安装路径。配置的 Profile 不存在、镜像版本不匹配或端口被占用，都会导致 ohosTest 启动失败。

Windows 测试机可以参考以下配置，并将 `D:/deveco/DevEco Studio` 替换为实际安装目录：

```json
{
  "server": {
    "devecoHome": "D:/deveco/DevEco Studio",
    "node": "D:/deveco/DevEco Studio/tools/node/node.exe",
    "sdkHome": "D:/deveco/DevEco Studio/sdk",
    "javaHome": "D:/deveco/DevEco Studio/jbr",
    "hvigorw": "D:/deveco/DevEco Studio/tools/hvigor/bin/hvigorw.js",
    "ohpm": "D:/deveco/DevEco Studio/tools/ohpm/bin/ohpm.bat"
  },
  "ohosTest": {
    "paths": {
      "hdc": "D:/deveco/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe",
      "emulatorBin": "D:/deveco/DevEco Studio/tools/emulator/Emulator.exe",
      "emulatorDeployedDir": "D:/deveco/Images"
    }
  }
}
```

`server.devecoHome` 不会替 ohosTest 和云测试自动推导上述工具、SDK 和 JDK 路径。虽然未配置时会回退到当前 Node、系统 `PATH` 或环境变量，但测试验收统一要求显式配置，以避免不同 PC 的环境差异影响结果。

### 3.5 配置云测试

如果本轮不验证云测试，可显式设置 `cloudTest.enabled` 为 `false`。需要验证时，准备以下内容：

- `cloudTest.teamId` 和 `cloudTest.projectId`，也可用 `AGC_TEAM_ID`、`AGC_PROJECT_ID` 环境变量覆盖；
- `cloudTest.signingConfigs` 对应的签名配置；
- `config/signing/` 下的 `.p12`、`.cer`、`.p7b` 及 `material/` 辅助材料；
- `config/agc-cookie.txt` 中的一行 Cookie 种子，或环境变量 `AGC_AUTH_INFO`。

签名材料路径和密码必须与测试机一致。Cookie 必须来自已进入目标团队项目的登录会话；个人态 Token 可能在刷新时返回 502。退出 AGC 登录后，原 Token 链可能失效，需要重新获取。

## 4. 用例准备

每个用例放在 `execution.casesRoot` 下的独立目录中，至少检查：

```text
<casesRoot>/
└── CaseExample/
    ├── PROMPT.md
    ├── metadata.json
    ├── test_patch.patch
    ├── golden_patch.patch       # 按用例需要提供
    └── base/ 或 task/           # 原始工程
```

检查要求：

- `PROMPT.md` 能独立描述需要 Agent 完成的任务；
- `metadata.json` 中的工程信息与实际目录一致；
- Patch 文件可正常应用，没有夹带本机绝对路径、构建缓存或临时文件；
- 原始工程未包含 `build/`、`.hvigor/`、`node_modules/`、`oh_modules/` 等历史产物；
- 用例依赖的 SDK、API 版本和系统能力已经安装在测试机。

## 5. 执行步骤

### 5.1 环境预检

```bash
node autorun.mjs --check
```

预期至少满足：

- OpenCode Server 可启动或可复用；
- `casesRoot` 存在并发现预期数量的用例；
- Agent 名称有效；
- Agent 模型和 Provider 能在 `opencode.json` 中匹配；
- 命令最终提示预检通过。

预检不会执行正式 Agent 任务，也不能替代模拟器、云测试和签名链路的正式验证。

### 5.2 正式执行

使用默认配置：

```bash
node autorun.mjs
```

使用单独的测试配置：

```bash
node autorun.mjs --config ./config/test.config.json
```

执行期间不要关闭终端或强制结束 Node.js 进程。控制台 Dashboard 应在同一表格区域原地更新，能够看到生成状态、测试状态、云测试、耗时、Token 和当前操作。

任务正常流程为：

```text
发现用例 -> Agent 生成与编译尝试
                    ├─ ohosTest
                    ├─ 云测试
                    └─ 白盒评价
                -> 汇总 result.json -> 生成 overview.html
```

ohosTest 跨用例串行使用本地设备；云测试的提交阶段串行、轮询阶段可并行；白盒评价按配置并发执行。因此不同模块结束时间不同是正常现象。

### 5.3 冒烟测试建议

第一次在新 PC 上测试时，建议只在 `casesRoot` 中放入一个规模较小的已知用例，并按以下顺序定位环境问题：

1. 先关闭云测试和白盒评价，只验证 Agent 生成与 ohosTest；
2. 单独开启白盒评价，确认裁判模型配置和报告生成；
3. 最后开启云测试，确认签名、Cookie、配额和设备链路；
4. 单用例全部通过后，再恢复正式用例集和 Agent 并发数。

## 6. 验收检查点

### 6.1 命令与批次级检查

- 进程没有未处理异常或“编排异常”；
- 批次结束后控制台给出成功、失败数量及报告路径；
- `output/<batchId>/batch.json`、`summary.json`、`report.json` 和 `overview.html` 均存在；
- `overview.html` 可直接用浏览器打开，数据显示完整；
- 云测试和白盒评价在总览中只展示摘要，并能通过“详细报告”链接打开各自 HTML。

### 6.2 Agent 运行

- 每个用例创建独立 session 和生成工程；
- `generate/input.txt`、`output.txt`、`agent-output.log`、`all-messages.json` 存在；
- `diff/changes.patch` 只包含 Agent 对业务工程的有效改动；
- `generate/compile-attempts.json` 能反映 Agent 实际尝试过的 Hvigor 编译命令和结果；
- 一个用例失败或超时不会阻止其他 Agent Worker 继续领取用例。

### 6.3 ohosTest

- 用例下生成 `.ohostest-runs/<runId>/result.json`、`summary.md`、`commands.jsonl` 和 `machine.json`；
- Runner 使用配置中的模拟器与端口，执行后能够完成设备清理；
- 测试断言失败应被记录为用例测试结果，不应表现为 Autorun 自身崩溃；
- ohosTest 失败时，云测试和白盒评价仍能继续或给出各自明确结果。

### 6.4 云测试

- 用例下生成 `cloudtest/cloudtest-result.json`、`cloudtest-report.html` 和构建日志；
- 报告能区分构建、上传、解析、提交和轮询阶段；
- `overview.html` 展示云测试总览并能跳转详细报告；
- Cookie 失效、配额不足或无可用设备时，报告应记录明确错误，而不是无限等待。

### 6.5 白盒评价

- 用例下生成 `whitebox/inputs/`、`whitebox/outputs/result.json`、`whitebox/report.html` 和日志；
- `original-prompt.md` 与源用例 `PROMPT.md` 一致；
- 裁判模型使用 `whiteboxEvaluation.judge` 指定的模型，而不是被强制替换为 Agent 模型；
- 报告中的编译来源表述为“生成 Agent 编译结果”，不出现“远端平台构建结果”等误导文案；
- Agent 工程不可编译或 ohosTest 失败时，白盒评价仍应执行并独立记录结果；
- `overview.html` 展示白盒结论摘要并能跳转 `whitebox/report.html`。

业务用例失败、云测试规则不通过或白盒分数较低，不等于测试工具自身失败。验收时要区分“工具完整执行并正确报告失败”和“工具链中断或报告错误”。

## 7. 结果目录与证据收集

正式运行结果位于：

```text
output/<batchId>/
├── overview.html
├── batch.json
├── summary.json
├── report.json
└── <caseName>/
    ├── result.json
    ├── generate/
    ├── diff/
    ├── .ohostest-runs/
    ├── cloudtest/
    └── whitebox/
```

提交问题时至少提供：

1. 批次 ID、用例名和问题发生时间；
2. 实际执行命令和完整控制台输出；
3. 脱敏后的配置文件；
4. `overview.html`、批次 JSON 和问题用例目录；
5. Node.js、npm、Git、Python、DevEco Studio、SDK 和 HarmonyBot 版本；
6. 预期结果、实际结果和稳定复现步骤。

对配置和日志脱敏时，必须删除 API Key、Cookie、Token、签名密码、个人账号和内网地址。不要只依赖截图遮挡，上传前还应检查原始 JSON、HTML 和日志内容。

## 8. 常见问题

### 8.1 `npm ci` 失败

- 确认在工程根目录执行，并且 `package-lock.json` 存在；
- 确认 Node.js 版本不低于 22.5.0；
- 检查 npm registry、代理和网络权限；
- 不要分别进入两个 workspace 安装依赖。

### 8.2 OpenCode Server、Agent 或模型校验失败

- 检查 `server.opencodeSource.mode` 和 `root`；
- 检查最终 `resources/opencode/opencode.json`、可执行文件和 `skills/` 是否存在；
- 检查 Provider 名称、模型 ID、API Key、网络、账户权限和余额；
- 修改资源或配置后，结束旧 Server 再重新执行预检。

### 8.3 模拟器无法启动或 hdc 不在线

- 用 `Emulator.exe -list -details` 核对 Profile；
- 检查镜像目录、`target`、`hdcPort` 和端口占用；
- 如果 `hdc` 已加入 PATH，可运行 `hdc list targets` 检查连接；
- 先在 DevEco Studio 中手工启动同一 Profile，确认镜像本身可用。

### 8.4 云测试返回 401、403 或 502

- 401/403：检查 Cookie 是否过期，以及 teamId、projectId 和账号权限；
- 502：重点检查 Cookie 是否来自已进入团队项目的会话；
- 检查签名包能否正常构建，证书、Profile、别名和密码是否匹配；
- 已成功提交但轮询中断时，可使用 `node autorun.mjs --poll-task <taskGroupId>` 续查。

### 8.5 白盒评价没有执行或报告缺失

- 检查 `whiteboxEvaluation.enabled`；
- 检查裁判 `providerId` 和 `modelId` 是否能在 `opencode.json` 中匹配；
- 执行 `npm run build:whitebox`，确认白盒 workspace 构建成功；
- 查看用例 `whitebox/logs/`、`state.json` 和 `result.json` 中记录的原因。

## 9. 测试完成清单

- [ ] 必备软件版本已记录。
- [ ] `npm ci` 和 `npm run build` 成功。
- [ ] `node autorun.mjs --check` 通过。
- [ ] 至少一个用例完成 Agent 生成。
- [ ] ohosTest 正常启动模拟器并生成报告。
- [ ] 云测试完成，或按测试范围验证了关闭/异常路径。
- [ ] 白盒评价使用指定裁判模型并生成报告。
- [ ] `overview.html` 汇总正确，详细报告链接可打开。
- [ ] Dashboard 刷新稳定，当前操作列信息可读。
- [ ] 失败场景有明确状态、原因和可定位日志。
- [ ] 提交的测试证据已完成敏感信息脱敏。
