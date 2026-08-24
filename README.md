# Muti-Device-Autorun

Autorun 是一个面向 OpenCode Agent 的批量自动执行工具。它会自动启动或复用 OpenCode Server，扫描 `execution.casesRoot` 配置目录下的用例，并通过固定并发的 Worker Pool 持续执行任务。

每个用例都使用独立的 OpenCode session、工程副本和结果目录。Agent 不会直接修改用例根目录中的原始工程。

## 主要功能

- 自动启动或复用 OpenCode Server。
- 支持 Windows、macOS 和 Linux 的 Node.js 运行环境。
- 自动扫描 `execution.casesRoot` 配置目录下的可执行用例。
- 从每个用例的 `PROMPT.md` 读取任务提示词。
- 通过可配置的 Worker Pool 并行执行多个用例。
- 任意用例完成后立即领取下一个待执行用例，不等待同批其他用例结束。
- 每个用例创建独立的 OpenCode session、`original/` 和工程目录；Agent 从开始到结束都在运行目录对应的 `base/` 或 `task/` 中工作。
- 使用 `prompt_async` 下发任务，并参考 SkillTest 的机制监听 Agent：
  - SSE 实时事件监听；
  - HTTP 消息轮询兜底；
  - 子 session、TODO、question 和 permission 监控；
  - question 默认自动选择第一个选项；
  - 仅把文本、推理、工具状态或工具输出的实际变化计为 Agent 活动；
  - 无活动超时和总运行时间限制；
  - 超时后自动中止主 session 和已发现的子 session。
- 捕获 `Ctrl+C`、终止信号、未捕获异常和自动启动的 Server 子进程退出，收尾运行中的用例状态。
- 下次启动时自动扫描并修复历史批次中遗留的 `running` 状态。
- 自动建立 Git 基线并生成 `changes.patch`。
- 保存批次状态、单用例状态、Agent 输出、SSE 事件和轮询记录。
- 批次完成后自动生成 HTML 报告（总览页 + 每用例详情页），总览页支持导出 Excel。
- 失败用例产物可打包上传到 AGC 云存储，生成下载链接并在 HTML 报告中展示。
- 支持合并多个批次的报告：把多轮回归的总览页数值自动求和、用例行汇总，生成跨批次总览页（`node autorun.mjs --merge`）。
- 支持集成 AGC 云测试：本地构建签名包 → 上传云测试 → 提交真机任务 → 轮询结果（`node autorun.mjs --cloud-test`）。

目前主流程只负责 Agent 执行和产物归档。使用生成工程继续执行编译、测试、设备验证等后续任务的能力将在后续版本补充。

## 环境要求

- Node.js 20 或更高版本，推荐使用当前 LTS 版本。
- Git，需要能够从命令行执行 `git`。
- DevEco Studio 及对应 HarmonyOS SDK、Node、ohpm 和 hvigor 工具链。
- 已准备一种 OpenCode 来源：`harmonyBot` 模式要求 VS Code 扩展目录下安装名称前缀为 `huaweideveloperserviceplatform.harmonyosdevassistantforvscode` 的扩展；`softwareEngineering` 模式要求资源包根目录下存在 `resources/opencode`。
- 所选来源的 `resources/opencode` 中需包含当前平台对应的 OpenCode 二进制、`opencode.json` 和 `skills/`。`harmonyBot` 还需包含任务使用的自定义 Agent、Plugin 和 Provider；`softwareEngineering` 允许只有 Skills，不要求自定义 Agent 或 Plugin。
- `opencode.json` 中需存在可用的模型配置和 API 凭据。`harmonyBot` 还应配置 Agent 执行所需的 allow/permission 权限。不要把真实 API Key 提交到 Git。

## 目录结构

```text
autorun/
├── autorun.mjs                 # 批量任务一键入口
├── config/
│   └── autorun.config.json     # 核心配置
├── src/                        # 内部入口和实现
│   ├── ask-opencode.mjs        # 人工执行单个 Agent 任务
│   ├── run-opencode-serve.mjs  # 独立启动 OpenCode Server
│   └── lib/                    # Autorun 内部模块
├── runner/                     # 内置 HarmonyOS ohosTest Runner
├── whitebox-evaluation/         # 独立白盒评价子系统
└── output/
    ├── _runtime/opencode/      # 生成 Agent 的 OpenCode 运行数据
    ├── _runtime/whitebox/      # 白盒裁判的独立 OpenCode 运行数据
    └── <batchId>/              # 正式批量运行结果
```

工程仅提供 `.mjs` 入口；在安装 Node.js 的 Windows、macOS 和 Linux 环境中均可运行。当前自动化主链不会依赖平台专用的 `.bat`、`.ps1` 或 `.sh` 脚本。
首次检出后需要安装内置 Runner 和白盒评价子系统的依赖并完成构建：

```bash
npm --prefix runner install
npm --prefix whitebox-evaluation install
npm --prefix whitebox-evaluation run build
```

## 用例格式

`execution.casesRoot` 指向的目录中，每个直接子目录代表一个用例。一个可执行用例至少需要包含：

```text
<casesRoot>/
└── CaseHomeStay/
    ├── base/ 或 task/          # 原始工程，Autorun 不会直接修改
    ├── PROMPT.md               # Agent 任务提示词
    ├── metadata.json           # ohosTest case 元数据
    ├── test_patch.patch        # 测试补丁
    └── golden_patch.patch      # swe 模式不应用，但 Runner 加载配置时要求存在
```

缺少 `base/`、`task/` 中任意一个工程目录或缺少 `PROMPT.md` 的用例不会进入 Agent 执行队列。工程目录名只支持 `base` 和 `task`；若两者同时存在则优先使用 `base`。启用 ohosTest 后，还必须存在合法的 `metadata.json` 及其引用的两个 patch，并且 `metadata.base_project` 必须与实际使用的工程目录名一致。`PROMPT.md` 应使用 UTF-8 编码且内容不能为空。

## 配置

核心配置位于 `config/autorun.config.json`。标准 JSON 不支持注释，各配置项的说明见下方表格。

```json
{
  "server": {
    "url": "http://127.0.0.1:61419",
    "opencodeSource": {
      "mode": "softwareEngineering",
      "root": "C:\\Users\\HW\\.vscode\\extensions\\software-multi-device"
    },
    "devecoHome": "D:\\deveco\\DevEco Studio",
    "loadAgents": []
  },
  "execution": {
    "casesRoot": "D:\\cases",
    "agent": "harmonyos-multi-device",
    "model": "deepseek-v4-flash",
    "additionalPrompt": "",
    "concurrency": 3
  },
  "whiteboxEvaluation": {
    "enabled": true,
    "concurrency": 2,
    "timeoutSec": 1800,
    "failurePolicy": "record_only",
    "judge": {
      "providerId": "deepseek",
      "modelId": "deepseek-v4-flash",
      "basePort": 62400
    },
    "prompt": {
      "includeAdditionalPrompt": true
    }
  },
  "ohosTest": {
    "paths": {
      "hvigorw": "hvigorw",
      "ohpm": "ohpm",
      "hdc": "hdc",
      "emulatorBin": "D:/deveco/DevEco Studio/tools/emulator/Emulator.exe",
      "emulatorDeployedDir": "D:/deveco/Images",
      "foldServerScript": "../runner/src/fold/assets/fold-server.py"
    },
    "devices": [
      {
        "id": "phone",
        "profile": "Pura 90",
        "target": "127.0.0.1:15001",
        "hdcPort": 15001,
        "startEmulator": true
      }
    ]
  },
  "cloudTest": {
    "enabled": true,
    "teamId": "260086000249430501",
    "projectId": "388421841221975192",
    "testCategories": [
      { "category": 24, "timeSpan": 40 }
    ],
    "pollIntervalSec": 60,
    "taskTimeoutSec": 3600
  }
  }
}
```

主要配置说明：

| 配置 | 说明 |
| --- | --- |
| `server.url` | OpenCode Server 地址。地址不可用时会自动启动 Server。 |
| `server.opencodeSource.mode` | OpenCode 来源模式，只支持 `harmonyBot` 或 `softwareEngineering`，二者互斥且不会合并、回退。 |
| `server.opencodeSource.root` | 来源根目录。`harmonyBot` 模式填写 VS Code 的 `extensions` 目录；`softwareEngineering` 模式填写包含 `resources/opencode` 的资源包根目录。 |
| `server.devecoHome` | DevEco Studio 安装目录。也可以用 `DEVECO_HOME` 环境变量覆盖。 |
| `server.hvigorw` / `server.ohpm` | 机器级工具路径（与 `devecoHome` 同级，云测试构建使用）：`hvigorw` 填 hvigorw.js 路径（自动以当前 node 运行）或可执行命令，`ohpm` 填 ohpm 命令；**含空格的路径会自动加引号**（如 Windows `D:\deveco\DevEco Studio\…`）；未配置则复用 `ohosTest.paths` 已有键，再退到 PATH 裸命令。 |
| `server.sdkHome` / `server.javaHome` | 可选：设置后注入 `DEVECO_SDK_HOME`/`JAVA_HOME`（云测试构建），未设置继承当前环境。 |
| `server.stopWhenFinished` | 是否关闭本次 Autorun 自动启动的 Server，默认 `true`。启动前已存在的 Server 不会被关闭。 |
| `server.loadAgents` | 指定自动启动的 Server 只加载这些 Agent（字符串数组）。留空（默认）加载 `opencode.json` 中的全部 Agent；配置后仅加载列出的 Agent，且 `execution.agent` 必须在列表中，否则启动即报错中止并提示修改配置。仅对 Autorun 自动启动的 Server 生效；复用已运行的 Server 时不重新过滤。 |
| `execution.casesRoot` | 用例根目录。 |
| `execution.outputRoot` | 批次、工程副本、报告及 OpenCode 运行数据的输出根目录，默认是项目根目录下的 `output`。Windows 下使用 Hvigor 时建议配置成 `D:/out`、`D:/ar` 等尽可能短的绝对路径，降低 259 字符路径上限导致的构建失败风险。 |
| `execution.agent` | `harmonyBot` 模式使用的 OpenCode Agent 名称。`softwareEngineering` 只有 Skills，固定使用 OpenCode 内置 `build` Agent，该字段在该模式下会被忽略。 |
| `execution.model` | 模型 ID。程序会从 Server `/config` 自动解析 Provider。 |
| `execution.additionalPrompt` | 统一追加到每个用例 `PROMPT.md` 内容后的提示词。未配置、空字符串或仅包含空白时不追加；不会修改源用例文件，实际发送内容可在用例输出的 `generate/input.txt` 中核对。 |
| `execution.concurrency` | 同时运行的 Agent 数量。任意任务结束后立即补充下一个任务。 |
| `execution.consoleMode` | 控制台模式：`dashboard`（默认动态看板）、`summary`（仅开始/结束）或 `verbose`（逐条进度）。非交互输出会自动退化为 `summary`。 |
| `execution.idleTimeoutSec` | Agent 连续无活动的超时时间，默认 `600` 秒。 |
| `execution.maxRuntimeSec` | 单个用例最大总运行时间，默认 `6000` 秒。 |
| `execution.continueOnError` | 单个用例失败后是否继续执行剩余用例，默认 `true`。 |
| `whiteboxEvaluation.enabled` | 是否启用白盒评价。启用后，白盒裁判与 ohosTest 并行执行。 |
| `whiteboxEvaluation.concurrency` | 白盒评价并发数，默认 `2`。每个并发使用独立裁判 OpenCode 端口。 |
| `whiteboxEvaluation.timeoutSec` | 单个白盒任务超时，默认 `1800` 秒。 |
| `whiteboxEvaluation.failurePolicy` | 当前支持 `record_only`：白盒失败只记录，不改变原用例状态。 |
| `whiteboxEvaluation.judge` | 选择裁判 Provider、模型和端口。`providerId` 必须与当前 OpenCode `opencode.json` 中的 Provider 名称完全一致；协议适配器、baseURL、API Key 和模型定义均从该 Provider 配置原样继承。 |
| `whiteboxEvaluation.prompt.includeAdditionalPrompt` | 是否将 `execution.additionalPrompt` 作为有效业务要求交给裁判，默认 `true`。 |
| `ohosTest.enabled` | 配置了 `ohosTest` 节点时默认启用，并在 Agent 适配完成后自动执行测试；显式配置为 `false` 时关闭。不配置整个 `ohosTest` 节点时不执行测试。 |
| `ohosTest.timeoutSec` | 单个 ohosTest 用例的最大运行时间，默认 `7200` 秒，超时后终止 Runner 及其子进程。 |
| `ohosTest.paths` | Runner 使用的 Hvigor、ohpm、hdc、模拟器和折叠屏服务脚本路径。 |
| `ohosTest.devices` | 测试设备矩阵。设备 ID、模拟器 profile、HDC 目标和端口均在此维护。 |
| `cloudTest.enabled` | 云测试是否作为主流程的一部分默认执行（Agent → ohosTest → 云测试）。默认 `true`；设为 `false` 关闭整个云测试流程（主批次与独立指令均不可用）。配置不完整时主批次会告警并跳过该阶段，独立指令则直接报错。 |
| `cloudTest.teamId` / `cloudTest.projectId` | AGC 云测试团队 ID 与项目 ID（请求头 `agcTeamId` / `productId`）。可用环境变量 `AGC_TEAM_ID` / `AGC_PROJECT_ID` 覆盖。 |
| `cloudTest.testCategories` | 测试类别配置，数组每项 `{ "category": 24, "timeSpan": 40 }`（类别 + 执行时长分钟）。设备列表查询、配额预检与任务提交共用该配置；未配置时默认 `[{ category: 24, timeSpan: 60 }]`。 |
| `cloudTest.pollIntervalSec` | 任务状态轮询间隔（秒），默认 60（1 分钟）。 |
| `cloudTest.proxy` | **OBS 直传专用代理**（`http://user:pass@host:port`，也支持 `host:port`；用户名密码含特殊字符时需 URL 编码），云测试 API 与 refresh 始终直连；也可用环境变量 `AGC_PROXY`。HTTPS 上传经 HTTP CONNECT 隧道传输；配置代理时默认跳过证书校验（兼容企业 MITM 自签证书）。 |
| `cloudTest.taskTimeoutSec` | 单个云测试任务的轮询总时长（秒），默认 7200（2 小时）；超时退出但任务仍在云端继续执行。 |
| `cloudTest.bundleName` | 补充签名：打包前替换工程 `AppScope/app.json5` 的 `bundleName`（需与签名 profile 匹配；不配置则保留工程原值）。 |
| `cloudTest.signingConfigs` | 补充签名：整体替换工程 `build-profile.json5` 的 `app.signingConfigs`（结构与 DevEco 一致，含 material 证书路径等）。待测工程通常不带签名信息，通过该配置注入；工程自带签名时可不配置。注入仅作用于构建沙箱副本，不修改源工程。证书路径支持绝对路径或相对 config 目录的相对路径；仓库在 `config/test.cer|p12|p7b` 提供了一套参考证书，该配置与各环境相关，默认不入库、自行填写。 |

云测试另有构建/提交类的可选调参（`product`、`buildMode`、`buildTimeoutSec`、`analyzeTimeoutSec`、`appClass`、`taskType`、`testItem`），由代码内置默认值提供、未写入配置文件，一般无需配置。

相对路径以 `config/autorun.config.json` 所在目录为基准解析。

`harmonyBot` 模式示例：

```json
{
  "server": {
    "opencodeSource": {
      "mode": "harmonyBot",
      "root": "C:\\Users\\HW\\.vscode\\extensions"
    }
  }
}
```

该模式会在 `root` 下查找最高版本且资源完整的 HarmonyBot 扩展。`softwareEngineering` 模式不会扫描 HarmonyBot 扩展，而是直接使用 `root/resources/opencode`，只加载其中的模型配置和 Skills，并使用 OpenCode 内置 `build` Agent。两种模式都将所选 `resources/opencode` 直接设置为 `OPENCODE_CONFIG_DIR`，不会复制、合并或回退到另一来源。修改模式、模型或权限配置后，应先结束已有 OpenCode Server 再重新执行，否则 Autorun 会复用旧 Server。

### Windows/Hvigor 输出路径建议

Autorun 会在 `outputRoot/<opencodeSource.mode>/<batchId>/<caseName>/<base|task>` 下创建实际参与 Agent 编译的工程。Hvigor 对部分构建路径执行 259 字符限制检查；工程中的 `build/cache/oh_modules/.ohpm` 会继续扩展多层目录，因此 Windows 下建议将 `execution.outputRoot` 配置成短的绝对路径：

```json
{
  "execution": {
    "casesRoot": "D:/cases",
    "outputRoot": "D:/out"
  }
}
```

修改后，批次报告和详细结果也会写入 `D:/out/<opencodeSource.mode>/<batchId>/`，OpenCode 运行数据默认写入 `D:/out/_runtime/opencode/`。仅开启 Windows 长路径或设置 `git core.longpaths` 不能绕过 Hvigor 自身的 Specification Limit 检查；如果用例名、模块名或依赖内部路径本身很长，应继续缩短 `outputRoot`，并尽量缩短用例、模块和 target 名称。

ohosTest 不会在 `.ohostest-runs/<runId>` 下编译工程，而是将 Agent 输出的 `base/task`
复制到同一用例目录下的浅层临时目录，应用隐藏测试 patch 后在该目录构建。报告仍写入
`.ohostest-runs/<runId>`。测试完成、失败、超时或中断后，Autorun 会将实际编译工程保留为
`<caseName>/ohostest-workdir/`，用于复现构建结果和定位问题，不会修改 Agent 输出工程。
Autorun 会通过 Runner 的 `--out` 参数指定唯一输出目录并监视其中的最终 `result.json`；
结果生成后若 npm 进程在 10 秒内仍未退出，会结束本次进程树并继续下一个 ohosTest。

### macOS 配置示例

可以直接修改 `devecoHome`，也可以通过环境变量覆盖：

```bash
export DEVECO_HOME="/Applications/DevEco-Studio.app"
node autorun.mjs
```

macOS 使用 `harmonyBot` 模式时，将 `server.opencodeSource.root` 配置为本机扩展目录，例如 `/Users/<用户名>/.vscode/extensions`；使用 `softwareEngineering` 模式时配置为对应资源包根目录。所选来源中需要存在当前 macOS 架构对应的 OpenCode 二进制。

## 使用方式

### 1. 配置预检

建议首次运行或修改配置后先执行：

```bash
node autorun.mjs --check
```

预检会检查：

- OpenCode Server 是否可用，不可用时自动启动；
- `casesRoot` 是否存在；
- 可执行用例数量；
- 配置的 Agent 是否存在；
- 配置的模型及 Provider 是否存在。

预检不会执行正式 Agent 任务。

### 2. 批量执行所有用例

```bash
node autorun.mjs
```

使用其他配置文件：

```bash
node autorun.mjs --config ./config/another.config.json
```

执行过程中会显示 Worker 领取用例、Agent 输出进度、用例完成情况和最终批次汇总。

### 3. 重试失败用例

重试历史批次中所有失败、中断或未执行的用例（新布局传 `<mode>/<batchId>`，如 `harmonyBot/20260821114859`；只传 `batchId` 时会在各模式目录下自动查找，旧版扁平批次 ID 仍然可用）：

```bash
node autorun.mjs --retry harmonyBot/20260821114859
```

只重试该批次中的某一个用例：

```bash
node autorun.mjs --retry harmonyBot/20260821114859 --case CaseAtomic
```

重试会创建一个新批次，不覆盖原批次。若历史结果中 Agent 已成功且工程、`changes.patch` 仍然存在，则复用 Agent 结果并只重新执行 ohosTest；Agent 未成功或历史产物已不存在时会重新执行 Agent，成功后再进入 ohosTest。显式指定 `--case` 时允许重试已成功用例，此时同样优先复用成功的 Agent 结果，只重新执行 ohosTest。

### 4. 单任务调试

确保 OpenCode Server 已运行，然后执行：

```powershell
node src/ask-opencode.mjs "帮我把当前工程下的文件名列出来" --agent harmonyos-multi-device --model deepseek-v4-flash -C "D:\cases\CaseHomeStay"
```

查看单任务参数：

```bash
node src/ask-opencode.mjs --help
```

### 5. 单独启动 OpenCode Server

通常不需要手工启动 Server。如果需要排查 Server 启动问题，可以执行：

```bash
node src/run-opencode-serve.mjs --source "C:\Users\HW\.vscode\extensions\software-multi-device\resources\opencode" --runtime-root ./output/_runtime/opencode --workspace .
```

`--source` 直接指向最终选中的 `resources/opencode` 目录。也可以用 `--root` 传入资源包根目录，脚本会读取其 `resources/opencode`；`--runtime-root`、`--port` 和 `--deveco-home` 分别设置运行目录、端口和 DevEco Studio 路径。Autorun 正常启动时会根据 `server.opencodeSource` 解析来源并自动传入 `--source`。

默认启动和 Autorun 自动启动都不会创建或写入旧的 `opencode/run/`。已有旧目录不会自动删除，以保留历史会话；确认不再需要后可手工归档或删除。

查看完整参数：

```bash
node src/run-opencode-serve.mjs --help
```

### 6. 上传失败用例产物

批次完成后，失败用例（整体状态非完成或测试项有失败/错误）的产物会自动打包为 ZIP 保存到各用例目录下。`upload.enabled` 设为 `true` 时同时上传到 AGC 云存储，生成下载链接并在 HTML 报告中展示；设为 `false`（默认）时仅保留本地 ZIP，不上传、不写 `upload-results.json`、HTML 不显示下载按钮。

**手动上传**（对已有批次补传）：

```bash
node src/upload-results.mjs output/<batchId>
```

上传行为：

- 只上传**失败或错误**的用例（整体通过且无测试失败的用例跳过）。
- 打包用例目录下的 `.ohostest-runs/`、`base/`（或 `task/`）和 `diff/` 三个子目录为 ZIP（DEFLATE 压缩，自动排除 `build`、`oh_modules`、`.hvigor` 等构建产物）。
- ZIP 文件名为 `{CaseName}_{batchId}.zip`，上传路径为 `ohostest/{CaseName}_{batchId}.zip`。
- 上传支持重试（默认 3 次），每次失败记录原因。每个用例上传后立即写 `upload-results.json`，中断后再次执行会跳过已成功的用例。
- 上传结果写入 `output/<batchId>/upload-results.json`，格式为 `{ "CaseName": { "url": "下载地址", "error": "失败原因", "uploadedAt": "时间" } }`。

上传成功后，重新生成 HTML 报告即可在总览页的「操作」列看到**下载**按钮，点击直接下载对应 ZIP。

```bash
# 先上传
node src/upload-results.mjs output/<batchId>
# 再刷新 HTML（自动读取 upload-results.json）
node src/generate-html-report.mjs output/<batchId>
```

### 7. 合并批次报告

多轮回归后，可把多个批次的总览报告合并成一份跨批次总览页：统计卡片（用例数、耗时等）按数值/单位/斜杠型自动求和，用例详情行汇总到同一张表，子页面按「批次名__原文件名」前缀隔离防覆盖。

```bash
# 合并默认 outputRoot（见配置）下所有含 overview.html 的批次目录
node autorun.mjs --merge

# 合并指定目录
node autorun.mjs --merge path/to/results

# 也可指定配置文件
node autorun.mjs --merge --config ./config/another.config.json
```

合并产物直接落在该根目录下：`overview.html`（跨批次总览）与 `subpage/`（汇总后的用例详情页）。该模式不启动 OpenCode Server、不执行用例，仅处理既有报告，可随时重跑。

### 8. 云测试（主流程默认执行 / `--cloud-test` 独立调试）

云测试是主流程的一部分，默认在每个用例的 Agent 完成后自动执行。**云测试（远端真机）与 ohosTest（本地模拟器）并行**：云测试上传包后只需轮询等待、不占用本地设备，两个分支都结束后合并出用例最终状态，云测试结果记录在用例 `result.json` 的 `cloudTest` 字段。多个用例的云测试提交阶段（构建+上传+提交）串行执行以规避频率限制，轮询阶段并行；模拟器测试保持跨用例串行（设备租约）。构建不与 ohosTest 合并：ohosTest 使用 debug 包（由 Runner 内部构建安装），云测试要求 release 签名包（由本流程构建上传），产物与签名不同，各自独立构建。设置 `cloudTest.enabled: false` 可整体关闭。

每用例的云测试流程：

1. 从工程 `AppScope/app.json5` 读取 `bundleName` / `versionName`，并校验 `build-profile.json5` 已配置签名（`app.signingConfigs` 非空，签名材料需本地预先配置好）；
2. 复制工程到输出沙箱（不污染源仓库），缺依赖时自动 `ohpm install --all`，再执行 `hvigor assembleApp` 生成签名 `.app`；
3. 查询云端历史已上传包（**暂不删除旧包**，发现同包名记录时直接重新上传）；
4. 申请 OBS 直传凭证 → 上传包 → 轮询云端解析结果（appInfoId、appType、API level 等）；
5. 查询可用真机列表（`business/device/list`，按包解析出的 appType/测试类别/API 版本过滤），**空闲设备在前、可排队设备在后**排序；
6. 按排序逐台尝试提交任务：每台提交前做配额预检，配额不足立即停止；单台提交失败（如设备被占用）自动换下一台；
7. 轮询任务组状态直到完成（**status 3/4/5/6 均视为已完成；resultStatus 非零（已出结果）也直接视为完成**；默认每 60 秒一次、最长 2 小时），结果写入 `output/cloudtest/<时间戳>/` 或用例目录的 `cloudtest/`。任务名默认为 **工程名_时间戳**（批次内为用例名如 `CaseXXX_20260818140000`，独立运行为工程目录名），`--task-name` 可覆盖。

独立调试指令（后续计划移除，仅调试用）：

```bash
# 对某个用例的 base 工程单独执行云测试（也可 --project task 指定 task 工程）
node autorun.mjs --cloud-test --case CaseTouristAttractionTicketAndMine

# 直接指定工程目录
node autorun.mjs --cloud-test --project-dir path/to/project

# 跳过构建，直接上传现成的签名 .app
node autorun.mjs --cloud-test --app path/to/xxx-signed.app

# 自定义任务名
node autorun.mjs --cloud-test --case CaseX --task-name MyTask_0817

# 轮询中断后（如 cookie 过期），仅续查已提交任务的状态
node autorun.mjs --poll-task 1296404946635560185
```

鉴权（与控制台 py 脚本一致）：**cookie 种子放在 `config/agc-cookie.txt`**（单行纯文本，整行 cookie / `agc_authInfo=...` 单对 / 裸 token 值均可，主域 `authInfo` 会自动派生；也可用环境变量 `AGC_AUTH_INFO`）。每次运行先调 `GET edge/oauth2/v1/refresh` 轮换登录态（GET + JSON body，需显式 Content-Length，cookie 为 `agc_authInfo` URL 编码单对）——**新 authInfo 在响应 Set-Cookie 的 agc_authInfo 项中，csrfToken 在响应 body 中**；之后所有接口只带四个鉴权头：`Cookie`（agc_authInfo 单对）、`agcCsrfToken`、`agcTeamId`、`productId`，不依赖浏览器整行 cookie/WAF 会话。token 每次轮换后旧值作废，运行中 401 会自动再 refresh 续链。注意：种子需来自**已进入团队项目的登录会话**（个人态原生 token——带 `signature` 无 `teamId`——刷新会报 502；进入团队控制台后轮换成带 `teamId` 的格式即可）；页面退出登录会作废整条 token 链。轮询中断后可用 `--poll-task <taskGroupId>` 续查。`teamId` / `projectId` 可用环境变量 `AGC_TEAM_ID` / `AGC_PROJECT_ID` 覆盖。

结果产物：`output/cloudtest/<时间戳>/` 下的 `cloudtest-result.json`（分阶段实时落盘，含构建、上传、解析、任务提交与轮询详情）、`cloudtest-report.html`（**HTML 结果页**：结果总览统计卡、应用/执行信息、设备×用例 PASS/FAIL 矩阵（FAIL 悬浮显示未通过规范条款号）、问题明细（规则号/描述/规范文档链接/出错位置）、设备执行明细；批量模式在 `<Case>/cloudtest/` 下，`--poll-task` 续查也会生成）、`build-console.log`（完整构建日志）与 `project/`（构建沙箱工程）。

## 并发执行机制

Autorun 启动时会扫描全部有效用例并建立待执行队列，然后启动 `concurrency` 个 Worker。

例如共有 10 个用例且 `concurrency: 3`：

```text
Worker 1 -> Case 1
Worker 2 -> Case 2
Worker 3 -> Case 3
```

如果 Case 2 最先结束，Worker 2 会立即领取 Case 4，不需要等待 Case 1 和 Case 3。直到待执行队列为空且所有 Worker 结束，当前批次才算完成。

启用 `ohosTest` 后，Agent Worker 和测试队列相互独立：Agent 每完成一个用例，就立即将该用例放入 ohosTest 队列，然后继续领取下一个 Agent 用例。ohosTest 队列固定并发数为 1，前一个用例完成模拟器启动、设备测试和清理后，才会执行下一个用例，避免多个用例争抢模拟器和端口。

Agent 运行期间，结果目录中只有工程和 Agent 自身产物，不会放入 `metadata.json`、`test_patch.patch` 或 `golden_patch.patch`。Agent 完成后，Autorun 才把源 case 的 metadata、测试 patch 以及 Runner 校验所需的 golden patch 复制到 `output/<batchId>/<caseName>/`，并执行 `ohostest:case --run swe`。此时 Runner 以 Agent 修改后的 `base/` 或 `task/` 为候选工程，只应用 `test_patch.patch`，不会应用 `golden_patch.patch`；Runner 结束后删除临时 golden patch。Autorun 会将当前配置中的 `ohosTest.paths` 和 `ohosTest.devices` 写入本次运行目录的 `machine.json`，再通过 `--machine-config` 传给内置 Runner。

Agent 的实际提示词会追加工作目录隔离要求，禁止枚举或读取当前工程以外的用例和评测文件。工程复制会排除 `.hvigor`、`build`、`node_modules` 等缓存/产物，避免历史构建日志泄漏源 case 路径。OpenCode Server 同时保持 `external_directory=deny`。

当前版本只扫描启动时已经存在的用例。运行过程中新增到 `casesRoot` 的用例需要在下一次启动时执行。

## 运行结果

每次正式执行会创建独立批次目录，按 `server.opencodeSource.mode`（如 `harmonyBot`）分层，`batchId` 为批次启动时间戳（`YYYYMMDDHHmmss`，同秒冲突时自动追加序号）：

```text
output/<opencodeSource.mode>/<batchId>/
├── batch.json                 # 当前批次和所有用例状态
├── summary.json               # 批次最终汇总
├── report.json                # Agent 与 ohosTest 指标明细
├── overview.html              # HTML 总览报告
├── subpage/                   # 各用例 HTML 详情页
└── <caseName>/
    ├── base/ 或 task/         # Agent 修改后的工程，也是 ohosTest 的 base_project
    ├── state.json             # 单用例状态
    ├── session.json           # OpenCode session 信息
    ├── metadata.json          # Agent 完成后从源 case 原样复制
    ├── test_patch.patch       # Agent 完成后从源 case复制
    ├── result.json            # 单用例最终结果
    ├── whitebox/              # 白盒评价输入、结果、日志和单文件 HTML
    │   ├── inputs/
    │   │   ├── input.json
    │   │   ├── original-prompt.md
    │   │   └── effective-prompt.md
    │   ├── outputs/
    │   │   ├── result.json
    │   │   └── agent-trace.json
    │   ├── report.html
    │   └── logs/
    ├── .ohostest-runs/        # harmonyos-ohostest-runner 自动生成
    │   └── <runId>/
    │       ├── machine.json   # 从 autorun.config.json 生成的本次设备配置
    │       ├── result.json
    │       ├── summary.md
    │       └── commands.jsonl
    ├── diff/
    │   └── changes.patch      # 相对于原始工程初始 Git 基线的 Agent 变更
    └── generate/
        ├── input.txt          # 实际发送的提示词
        ├── output.txt         # Agent 最终文本输出
        ├── final-message.json # OpenCode 最终消息
        ├── agent-console.log  # 执行期间可实时跟踪的关键进度
        ├── agent-output.log   # 主/子 Session 的完整可读输出与工具记录
        ├── all-messages.json  # 主/子 Session 的完整原始消息
        ├── opencode-sse.jsonl # 仅 Agent 失败、超时或中断时保留
        ├── opencode-polling.jsonl # 仅 Agent 失败、超时或中断时保留
        └── compile-attempts.json # Agent build attempt details; excludes ohosTest
```

白盒评价从源用例的 `PROMPT.md` 直接读取原始 Prompt，不从 Agent 消息或 ohosTest 元数据反推。`original-prompt.md` 保留原文，`effective-prompt.md` 是实际交给裁判的版本；当 `prompt.includeAdditionalPrompt=true` 时，后者会追加 `execution.additionalPrompt`。运行时系统约束、隐藏测试 Patch、golden patch 和 ohosTest 测试名不会进入裁判 Sandbox。

Agent 结束后，Autorun 会在 Patch、生成工程、白盒 Sandbox 和失败用例 ZIP 边界统一排除 `.onemulti/`、`__pycache__/`、`*.pyc` 和 `**/evidence/tmp/`。这些 Agent 工具链与临时证据不属于业务交付内容，也不参与 ohosTest 或白盒评分。

生成 Agent 的 Hvigor 编译尝试会以结构化 `agentBuild` 输入交给白盒评价，保留每次真实任务、命令、退出码和顺序。白盒以最后一次有效尝试作为最终编译结果，报告来源显示为“生成 Agent 编译结果”，与 ohosTest 状态独立。

ohosTest 执行期间会先创建 `<caseName>/work/` 作为实际编译工程；执行结束后统一重命名并保留为
`<caseName>/ohostest-workdir/`。用例 `result.json` 的 `ohosTest.workDir` 会记录其绝对路径。
该目录包含完整工程和构建缓存，便于定位问题，但会明显增加批次结果占用的磁盘空间，可在排查结束后手动删除。

Agent 成功生成 `changes.patch` 后会删除临时 `original/`；Agent 成功时还会删除 SSE、轮询日志。ohosTest 结束后会从最终 `base/` 或 `task/` 工程中清理 `.git`、`.hvigor`、`build` 和 `node_modules` 等可再生成目录，但始终保留 `all-messages.json` 以及 `work/` 或 `ohostest-workdir/`。`golden_patch.patch` 仅在 SWE 启动校验期间临时复制，Runner 结束后删除。

`result.json` 使用 `projectName` 和 `projectDir` 记录 Agent 最终工程名及其绝对路径，并直接包含 Agent 的最终回复 `output`；`tokenUsage` 记录输入、输出、reasoning、缓存、总 Token 和 cost，`ohosTest` 记录测试状态、耗时及 Runner 原生结果路径，`logs` 列出完整输出和原始消息路径，Agent 异常时还会列出 SSE、轮询日志路径。`summary.json` 同时保存批次使用的 `agent`、`providerId`、`modelId`、全批次 Token 汇总和各用例 ohosTest 结果。为避免 `result.json` 过大，完整过程不会重复内嵌其中；查看 `generate/agent-output.log` 即可阅读完整 Agent 过程。

执行期间单独跟踪某个用例：

```powershell
Get-Content "D:\autorun\output\<batchId>\<caseName>\generate\agent-console.log" -Encoding UTF8 -Wait
```

用例执行完成后查看 Agent 完整输出：

```powershell
Get-Content "D:\autorun\output\<batchId>\<caseName>\generate\agent-output.log" -Encoding UTF8 -Raw
```

动态看板只在固定区域原地更新每个用例的状态、耗时、Token 和当前操作，不持续追加整张表。宽终端显示输入、输出、总 Token 三列，中等宽度合并显示，窄终端只显示总量或自动隐藏 Token 列。批次结束后保留最终表格，并为每个用例打印 `agent-output.log` 路径。

状态大致按以下阶段变化：

```text
pending -> running/preparing -> session_creating -> agent_running
        -> artifacting -> ohostest_queued -> ohostest_running
        -> completed | failed | timed_out | interrupted
```

## 常见问题

### OpenCode Server 未启动或启动超时

检查：

- `server.opencodeSource.mode` 是否为 `harmonyBot` 或 `softwareEngineering`；
- `server.opencodeSource.root` 是否正确，以及选中来源的 `resources/opencode/` 是否完整；
- 当前平台对应的 OpenCode 二进制是否存在；
- `server.devecoHome` 或 `DEVECO_HOME` 是否正确；
- 配置端口是否被其他程序占用；
- `output/_runtime/opencode/logs/runs/*-opencode-serve/opencode-server.log` 中的启动日志。

Autorun 会先等待 `/global/health`，再等待 `/config` 完成 Agent、Plugin、Skill 和 Provider 加载；只有两项都成功后才显示“OpenCode Server 已就绪”。配置加载使用 120 秒总等待窗口并允许重试，避免冷启动超过 30 秒时被误判为模型请求失败。

### 找不到 Agent 或模型

执行：

```bash
node autorun.mjs --check
```

确认当前来源的 `resources/opencode/opencode.json` 中存在对应模型配置，并确认修改后已经重启 OpenCode Server。`harmonyBot` 模式还需确认对应 Agent、Plugin 和 allow/permission 权限配置完整；`softwareEngineering` 不要求自定义 Agent 或 Plugin，使用内置 `build` Agent。

### 一多适配任务没有调用 Skill

`harmonyos-multi-device` 正常启动时会加载插件注入的 Agent prompt，并注册 `harmonyos-ui-multi` Skill。Autorun 会在执行用例前检查这两项；如果插件或 Skill 的运行时路径失效，会直接报错而不再静默执行。

自动启动 Server 时，Autorun 会把当前模式选中的 `resources/opencode` 直接设置为 `OPENCODE_CONFIG_DIR`，不会复制或映射资源。若复用了修复前启动的旧 Server，请先停止旧 Server，再重新执行 `node autorun.mjs`。

### 提示 `external_directory=deny` 未生效

运行中的 Server 可能仍使用修改前的配置。停止旧 Server 后重新执行 `node autorun.mjs`，让 Autorun 自动启动并重新加载配置。

### 没有发现可执行用例

确认每个用例是 `casesRoot` 的直接子目录，并同时包含：

```text
base/ 或 task/
PROMPT.md
```

### 复制用例时出现 `EPERM ... symlink`

部分 HarmonyOS 工程会在 `oh_modules` 中使用 Windows Junction。Autorun 会在复制用例时自动把这类目录联接重映射到当前运行沙箱，不需要管理员权限，也不会让链接指回源用例工程。

如果仍出现该错误，请确认使用的是包含 `src/lib/sandbox-copy.mjs` 的当前版本，并重新启动 `node autorun.mjs`。已经启动的 Node 进程不会加载后续代码修改；失败批次可以保留用于排查，重新运行会创建新的批次目录。

### Agent 长时间没有结束

控制台进度会区分“等待模型响应”“正在分析”“工具执行中”和“已生成回复”。监控会保留上一条有效操作；OpenCode 新建的空 `step-start` 消息不会再被误报成“等待首次模型输出”，也不会刷新空闲超时。Agent 在读取工程、搜索文件或修改源码时，工具状态、工具输出和 reasoning 的实际变化仍表示任务正在推进。

检查对应 case 的：

```text
generate/opencode-sse.jsonl
generate/opencode-polling.jsonl
```

上述两个原始监控日志只在 Agent 失败、超时或中断时保留。可以适当调整 `idleTimeoutSec` 和 `maxRuntimeSec`。超时后 Autorun 会尝试中止主 session 和子 session，并保留最后消息和 `base/` 或 `task/` 工程。

当 Agent 发生空闲或总时长超时时，Autorun 仍会把已生成的 `base/` 或 `task/` 工程和 `changes.patch` 放入串行 ohostest 队列。最终用例状态由 ohostest 决定：其编译或执行失败会显示为失败/超时；若测试通过，则显示完成，并在 `result.json` 中保留 `agentStatus: "timed_out"` 与 `agentError` 供追溯。用户主动中断批次时不会再启动 ohostest。

所有 `hvigorw` 命令（包括 `tasks`）都应使用 `--no-daemon`，例如：

```powershell
hvigorw.bat tasks --no-daemon
```

### 批次或用例一直显示 running，但进程已经结束

Autorun 会在正常可捕获的中断中把正在执行的用例标记为 `interrupted`，尚未开始的用例标记为 `cancelled`，并写入 `result.json` 和批次 `summary.json`。

对于任务管理器强制结束、断电等无法现场收尾的情况，下次执行 `node autorun.mjs` 或 `node autorun.mjs --check` 时会扫描工程内的 `output/`，将遗留批次标记为 `interrupted`。已完成、失败或超时的用例状态不会被覆盖。

### API 请求返回 401、403 或模型不可用

检查 OpenCode Provider 的 API Key、账户权限、余额、模型 ID 和网络连接。不要把 API Key 提交到公共代码仓库。
