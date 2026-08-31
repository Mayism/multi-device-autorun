# Muti-Device-Autorun

Autorun 是一个面向 OpenCode Agent 的批量自动执行工具。它会为每个 Agent 自动启动独立 OpenCode Server，扫描 `execution.casesRoot` 配置目录下的用例，并通过固定并发的 Worker Pool 持续执行任务。

每个用例都使用独立的 OpenCode session、工程副本和结果目录。Agent 不会直接修改用例根目录中的原始工程。

## 主要功能

- 为每个 Agent 自动启动并关闭独立 OpenCode Server。
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
  - permission 强制全部允许，question 自动选择允许、继续或推荐方案，自由文本确认也会自动回复；
  - 仅把文本、推理、工具状态或工具输出的实际变化计为 Agent 活动；
  - 无活动超时和总运行时间限制；
  - 实时识别模型 API 限额：周期用量上限立即中止用例并标记「限额」，瞬时限流继续等待重试；
  - 超时后自动中止主 session 和已发现的子 session。
- 捕获 `Ctrl+C`、终止信号、未捕获异常和自动启动的 Server 子进程退出，收尾运行中的用例状态。
- 下次启动时自动扫描并修复历史批次中遗留的 `running` 状态。
- 自动建立 Git 基线并生成 `changes.patch`。
- 保存批次状态、单用例状态、Agent 输出、SSE 事件和轮询记录。
- 批次完成后自动生成 HTML 报告（总览页 + 每用例详情页），总览页支持导出 Excel，并含白盒评价（状态/总分/裁判模型 + 详情直链）与云测试（统计卡片 + 报告直链）章节。
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
- `opencode.json` 中需存在可用的模型配置和 API 凭据。Autorun 启动 Server 时会生成运行时配置副本并强制覆盖全局及 Agent 权限为 `allow`；来源配置不会被修改。不要把真实 API Key 提交到 Git。

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

Autorun 启动时会执行 `devecocli --version`，检查 DevEco CLI 并显示版本。通用启动检查中，命令不可用只会告警；但 `harmonyBot` 的 `harmonyos-multi-device` 需要按一多 Skill 使用该 CLI，因此还会在 Agent 的实际 PATH 下做必需依赖预检，缺失时阻断模型会话。可安装或修复：

```bash
npm install -g @deveco/deveco-cli@latest
devecocli --version
```

安装成功后，从能执行 `devecocli --version` 的同一个终端重启 Autorun。使用 nvm 时，全局包属于安装时选中的 Node 版本；切换版本或从 IDE 启动可能导致 Agent 的 PATH 找不到已安装命令。

启动 Autorun 的 Node 也必须满足所安装 CLI 的版本要求（例如 `devecocli 1.3.1` 要求 Node >=22）。在 macOS/Linux 上，Autorun 为 PATH 中已安装的 Node 版 `devecocli` 创建私有启动脚本，固定使用启动 Autorun 的 Node；预检和 Agent 共用该脚本，避免 DevEco 自带的 Node 18 抢占解释器。此设置不改变 Hvigor/ohpm 原有的 PATH；启动日志会显示 `devecocli Node` 的路径和版本。

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
    "devecoHome": "D:\\deveco\\DevEco Studio"
  },
  "execution": {
    "casesRoot": "D:\\cases",
    "agent": "harmonyos-multi-device",
    "providerId": "deepseek",
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
| `server.opencodeSource.mode` | 单 Agent 兼容配置的来源模式，只支持 `harmonyBot` 或 `softwareEngineering`。 |
| `server.opencodeSource.root` | 单 Agent 来源根目录。`harmonyBot` 模式填写 VS Code 的 `extensions` 目录；`softwareEngineering` 模式填写包含 `resources/opencode` 的资源包根目录。 |
| `server.opencodeSource.targets` | 多 Agent 串行目标数组。每项必须提供唯一 `id`、`mode`、`root`，`harmonyBot` 目标还可单独指定 `agent`。目标严格按数组顺序串行执行。 |
| `server.opencodeSource.continueOnTargetError` | 某个 Agent 启动或执行失败后是否继续下一个 Agent，默认 `true`。 |
| `server.devecoHome` | DevEco Studio 安装目录。也可以用 `DEVECO_HOME` 环境变量覆盖。 |
| `server.hvigorw` / `server.ohpm` | 机器级工具路径（与 `devecoHome` 同级，云测试构建使用）：`hvigorw` 填 hvigorw.js 路径（自动以当前 node 运行）或可执行命令，`ohpm` 填 ohpm 命令；**含空格的路径会自动加引号**（如 Windows `D:\deveco\DevEco Studio\…`）；未配置则复用 `ohosTest.paths` 已有键，再退到 PATH 裸命令。 |
| `server.sdkHome` / `server.javaHome` | 可选：设置后注入 `DEVECO_SDK_HOME`/`JAVA_HOME`（云测试构建），未设置继承当前环境。 |
| `server.stopWhenFinished` | 单来源兼容字段。隔离执行始终在每个 Agent 结束后关闭其专属 Server，避免状态进入下一个 Agent。 |
| `execution.casesRoot` | 用例根目录。 |
| `execution.outputRoot` | 批次、工程副本、报告及 OpenCode 运行数据的输出根目录，默认是项目根目录下的 `output`。Windows 下使用 Hvigor 时建议配置成 `D:/out`、`D:/ar` 等尽可能短的绝对路径，降低 259 字符路径上限导致的构建失败风险。 |
| `execution.agent` | `harmonyBot` 模式使用的 OpenCode Agent 名称。`softwareEngineering` 只有 Skills，固定使用 OpenCode 内置 `build` Agent，该字段在该模式下会被忽略。 |
| `execution.providerId` | 生成模型 Provider ID。多 Agent 对比时必填；Autorun 从一个包含该模型的来源冻结 Provider 配置并注入全部目标。 |
| `execution.providerSourceTargetId` | 可选：指定从哪个 Agent 目标读取统一 Provider 配置；未指定时按 `targets` 顺序选择第一个包含指定模型的来源。 |
| `execution.model` | 全局生成模型 ID。所有 Agent 共用，目标配置不能覆盖；单 Agent 未配置 `providerId` 时会从 Server 唯一匹配。 |
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

该模式会在 `root` 下查找最高版本且资源完整的 HarmonyBot 扩展。`softwareEngineering` 模式不会扫描 HarmonyBot 扩展，而是直接使用 `root/resources/opencode`，加载其中的模型配置和 Skills，并使用 OpenCode 内置 `build` Agent。正式执行时 Autorun 会把所选来源的 `plugin`、`skills`、`provider` 复制到当前目标的私有 runtime 配置快照，不会合并或回退到另一来源，也不会复用启动前已有的 OpenCode Server。`softwareEngineering` 还会关闭 `~/.agents/skills` 和 `~/.claude/skills` 扫描，并通过精确权限白名单阻止 OpenCode 内置 Skill，只向 Agent 暴露来源 `resources/opencode/skills` 下的 Skill。

多 Agent 串行对比配置示例：

```json
{
  "server": {
    "opencodeSource": {
      "strategy": "serial",
      "continueOnTargetError": true,
      "targets": [
        {
          "id": "harmonybot",
          "label": "HarmonyBot",
          "mode": "harmonyBot",
          "root": "C:\\Users\\HW\\.vscode\\extensions",
          "agent": "harmonyos-multi-device"
        },
        {
          "id": "software-engineering",
          "label": "Software Engineering",
          "mode": "softwareEngineering",
          "root": "C:\\tools\\software-multi-device"
        }
      ]
    }
  },
  "execution": {
    "providerId": "deepseek",
    "model": "deepseek-v4-flash"
  }
}
```

每个目标使用独立 OpenCode Server、配置资产副本、数据库、状态、缓存、日志和 workspace。批次级 Provider 配置只包含统一生成模型及其连接配置，不会携带来源的 Agent、Plugin 或 Skill；它会以权限受限的快照文件注入所有目标。`softwareEngineering` 会在 Agent Session 创建前校验来源 Skill 与权限白名单完全一致；OpenCode 固定注册但已被拒绝的内置 Skill 只记录在 `environment.json` 的 `skills.blocked`，不会进入 `skills.loaded` 或模型会话。多个目标还会共用一份启动时冻结的用例输入快照，保证后执行的 Agent 不会读取前一个 Agent 修改后的工程。

### Windows/Hvigor 输出路径建议

Autorun 会在 `outputRoot/<batchId>/<agentId>/<caseName>/<base|task>` 下创建实际参与 Agent 编译的工程。Hvigor 对部分构建路径执行 259 字符限制检查；工程中的 `build/cache/oh_modules/.ohpm` 会继续扩展多层目录，因此 Windows 下建议将 `execution.outputRoot` 配置成短的绝对路径：

```json
{
  "execution": {
    "casesRoot": "D:/cases",
    "outputRoot": "D:/out"
  }
}
```

修改后，批次报告和详细结果会写入 `D:/out/<batchId>/<agentId>/`，根级总览位于 `D:/out/<batchId>/overview.html`。OpenCode 运行数据默认按 `<batchId>/<agentId>` 隔离写入 `D:/out/_runtime/opencode/`。仅开启 Windows 长路径或设置 `git core.longpaths` 不能绕过 Hvigor 自身的 Specification Limit 检查；如果用例名、模块名或依赖内部路径本身很长，应继续缩短 `outputRoot`，并尽量缩短用例、模块和 target 名称。

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
- 本机的可选 DevEco CLI 是否可以实际运行，并输出版本或安装提示。

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

### 6. 打包与上传用例产物

批次完成后，**所有用例**（含 completed/skipped）的产物都会自动打包为 ZIP 保存到各用例目录下，用于归档与结果分发。`upload.enabled` 设为 `true` 时，失败或错误用例（整体状态非完成或测试项有失败/错误）的 ZIP 同时上传到 AGC 云存储，生成下载链接并在 HTML 报告中展示；设为 `false`（默认）时仅保留本地 ZIP，不上传、不写 `upload-results.json`、HTML 不显示下载按钮。

**手动补打包/上传**（对已有批次）：

```bash
node src/upload-results.mjs output/<batchId>/<agentId>
```

上传行为：

- **所有用例**都会生成本地 ZIP；只上传**失败或错误**的用例到 AGC 云存储（整体通过且无测试失败的用例仅保留本地 ZIP）。
- 打包用例目录下的全部内容为 ZIP：包括 `base/`（或 `task/`）、工程内的 `.onemulti/`（Skill 脚本、账本、正式证据和适配 HTML 报告）、`generate/`、`diff/`、`.ohostest-runs/`、`ohostest-workdir/`、`whitebox/`、`cloudtest/` 等产物（ZIP 输出文件本身不重复入包；DEFLATE 压缩，仍排除 `build`、`oh_modules`、`.hvigor`、`node_modules`、`__pycache__`、`*.pyc` 和 `**/evidence/tmp/` 等可再生成或临时内容）。
- ZIP 文件名为 `{CaseName}_{batchId}.zip`，上传路径为 `ohostest/{CaseName}_{batchId}.zip`。
- 上传支持重试（默认 3 次），每次失败记录原因。每个用例上传后立即写 `upload-results.json`，再次执行仍重建本地 ZIP，但已有上传链接的用例不重复上传。旧 ZIP 不会自动迁移；手动补打包可把本地仍保留的 `.onemulti` 加入归档，已有云端 ZIP 不会随本地重建自动更新。
- 上传结果写入 `output/<batchId>/<agentId>/upload-results.json`，格式为 `{ "CaseName": { "url": "下载地址", "error": "失败原因", "uploadedAt": "时间" } }`。

上传成功后，重新生成 HTML 报告即可在总览页的「操作」列看到**下载**按钮，点击直接下载对应 ZIP。

```bash
# 先上传
node src/upload-results.mjs output/<batchId>/<agentId>
# 再刷新 HTML（自动读取 upload-results.json）
node src/generate-html-report.mjs output/<batchId>/<agentId>
```

### 7. 合并批次报告

多轮回归后，可把多个批次的执行结果合并成一份跨批次总览页。合并脚本按五步主流程组织（`src/lib/merge-overview.mjs`，每步独立成模块方法）：

1. **发现批次报告** `discoverBatches`：扫描批次目录，兼容旧版 `<来源>/<批次>` 和新版 `<批次>/<agentId>` 两层布局，按名称排序；只依据 `summary.json` 识别 Agent 批次，缺 `summary.json` 的目录跳过并告警。
2. **清理旧产物** `cleanOldArtifacts`：删除旧 overview.html 与 subpage/ 并重建目录，保证每次合并从干净状态开始。
3. **读取批次数据** `readBatchData`：读取各批次 `summary.json` / `report.json` / `upload-results.json` 及用例级 runner result，按与批次报告同口径组装 caseRows。
4. **合并数据** `mergeData`：数据层合并后**逐模块产出 HTML 片段**——配置总览、结果总览、用例执行一览、白盒评价、云测试，以及 skill 章节（`merge-skill.mjs` 返回的数据就是 HTML，直接作为片段）。统计口径：计数类（用例总数、完成/失败、总 Token、模型/工具调用、执行用例个数、通过/失败/错误、白盒完成/失败）跨批次求和；白盒平均分复用 `batch-report` 的 `buildWhiteboxSummary` 在全部用例上整体重算；Agent/providerId/模型相同取一个、不同用「/」分隔。**白盒评价章节**合并各批次用例的 `whitebox` 结果（状态/总分/裁判模型），详情链接直连各批次 `<Case>/whitebox/report.html`；**云测试章节**合并各用例 `cloudTest` 结果（状态取 result.json，设备/规则/问题指标读各用例 `cloudtest/cloudtest-result.json` 的 `report.summary`），卡片（参与用例、设备通过/失败、规则通过/失败、问题数量）跨批次求和，报告链接直连各用例 `cloudtest-report.html`。合并页**不看阶段开关**：批次结果里有数据就合并、没有就跳过，章节由行数据驱动。批次页则跟随开关：未开启的阶段整章省略（忽略 retry 继承的残留数据），开启但零数据时渲染空态。
5. **生成 HTML** `generateHtml`：用 `pageShell` 把各模块片段按序组装（配置总览 → 结果总览 → 用例执行一览 → 白盒评价 → 云测试 → skill 质量评估 → skill 安全审计）写盘。

- **用例表**：行按批次顺序拼接，不添加批次列，也不含「云测试」「白盒评价」列；两者的结果分别在紧随其后的「白盒评价」「云测试」独立章节展示（含各自报告的直链入口）。
- **用例详情直链**：不再拷贝 subpage 副本，用例名/查看详情直接链接各批次目录内的 `subpage/<用例>.html`（合并页位于批次目录上一级，链接带「批次相对路径/」前缀）；批次无子页面（如仅有 summary.json 的历史批次）时用例名以纯文本展示。
- **skill 报告章节（可选）**：若存在 `src/lib/merge-skill.mjs`，第 4 步自动调用其导出的两个章节方法，返回的 HTML 作为 skill 模块片段——`mergeSkillEvalSection`（skill 质量评估，调用带 `await`）与 `mergeSkillAuditSection`（skill 安全审计）。两个方法入参均为 `{ batchDataList, batchNames, outputRoot }`：`batchDataList` 为各批次源数据数组（含 batch 标识与 summary/report/results），`batchNames` 为批次名数组，`outputRoot` 为输出根目录。文件不存在则整体跳过；单个方法缺失时仅跳过对应章节。

```bash
# 合并默认 outputRoot（见配置）下所有含 summary.json 的批次目录
node autorun.mjs --merge

# 合并指定目录
node autorun.mjs --merge path/to/results

# 也可指定配置文件
node autorun.mjs --merge --config ./config/another.config.json
```

合并产物直接落在该根目录下：`overview.html`（跨批次总览）与 `subpage/`（汇总后的用例详情页）。该模式不启动 OpenCode Server、不执行用例，仅处理既有报告，可随时重跑。

### 8. 云测试（主流程默认执行 / `--cloud-test` 独立调试）

云测试是主流程的一部分，默认在每个用例的 Agent 完成后自动执行。**云测试（远端真机）与 ohosTest（本地模拟器）并行**：云测试上传包后只需轮询等待、不占用本地设备；两个分支互不依赖，控制台的“测试状态”“云测试”两列在各自分支结束时独立定格，全部分支结束后再合并定级用例最终状态，云测试结果记录在用例 `result.json` 的 `cloudTest` 字段。多个用例的云测试提交阶段（构建+上传+提交）串行执行以规避频率限制，轮询阶段并行；模拟器测试保持跨用例串行（设备租约）。构建不与 ohosTest 合并：ohosTest 使用 debug 包（由 Runner 内部构建安装），云测试要求 release 签名包（由本流程构建上传），产物与签名不同，各自独立构建。设置 `cloudTest.enabled: false` 可整体关闭。

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

Agent 运行期间，结果目录中只有工程和 Agent 自身产物，不会放入 `metadata.json`、`test_patch.patch` 或 `golden_patch.patch`。Agent 完成后，Autorun 才把源 case 的 metadata、测试 patch 以及 Runner 校验所需的 golden patch 复制到 `output/<batchId>/<agentId>/<caseName>/`，并执行 `ohostest:case --run swe`。此时 Runner 以 Agent 修改后的 `base/` 或 `task/` 为候选工程，只应用 `test_patch.patch`，不会应用 `golden_patch.patch`；Runner 结束后删除临时 golden patch。Autorun 会将当前配置中的 `ohosTest.paths` 和 `ohosTest.devices` 写入本次运行目录的 `machine.json`，再通过 `--machine-config` 传给内置 Runner。

Agent 的实际提示词会追加无人值守确认和“业务工程 + 授权工具资源”边界：所有 permission 自动允许，question 自动采用允许、继续、推荐或默认方案；禁止读取其他用例、隐藏测试、标准答案和评测结果，但允许读取当前来源实际注册的 Skill 快照，并从工程 cwd 调用其中的脚本，以及读取明确列出的 SDK/工具目录。授权不扩大到整个 runtime、父目录或 Provider 配置。这是提示词约束，不是操作系统级文件沙箱。工程复制会排除 `.hvigor`、`build`、`node_modules` 等缓存/产物，避免历史构建日志泄漏源 case 路径。

`harmonyBot` 的 `harmonyos-multi-device` 在会话创建前，由 Autorun 从本 Agent 的私有 Skill 快照将 `harmonyos-ui-multi` 预装到工程 `.onemulti/`。预检使用启动器返回的 Agent PATH/SDK 环境，检查 Python >= 3.10、`devecocli --version`、必需脚本和关键脚本的 `--help`；缺少必需依赖即在模型会话前报错。安装不使用 `--agents-md`，并恢复安装器改动的 `.gitignore`，通过 Git 内部 exclude 排除工具副本；不修改原始工程或借用其他 Agent 的 Skill。账本和证据按用例独立保留。脚本调用要求每次显式设置 cwd 和脚本路径，不依赖前一次 shell 的 `$OM`；运行时形态证据仍需按 Skill 完成并遵守设备租约。

Agent 正常结束后，Autorun 运行 Skill 的账本与状态校验并检查汇总 HTML，结果写入 `generate/skill-workflow.json` 和用例 `result.json.skillWorkflow`。`validated` 仅表示这些产物检查通过，不代表所有设备验证通过；不完整时标记 `incomplete` 并记日志，仍继续独立的 ohosTest/白盒评价，不用流程检查替代测试结果。

当前版本只扫描启动时已经存在的用例。运行过程中新增到 `casesRoot` 的用例需要在下一次启动时执行。

## 运行结果

每次正式执行会创建独立的时间戳批次目录，`batchId` 为批次启动时间戳（`YYYYMMDDHHmmss`，同秒冲突时自动追加序号）。一个或多个 Agent 都使用同一个批次目录；每个 Agent 的产物按配置中的稳定 `id` 隔离。根级 `overview.html` 是统一入口，每个 Agent 目录保留可下钻的完整报告，多 Agent 时额外生成 `comparison.json`：

```text
output/<batchId>/
├── overview.html              # 整次运行的统一入口
├── comparison.json            # 仅两个及以上 Agent 时生成
├── input-snapshot.json         # 多 Agent 共用输入快照的文件数与 SHA-256
└── <agentId>/
    ├── environment.json       # 来源、模型、runtime 和实际 Skill 清单
    ├── batch.json             # 当前 Agent 批次和所有用例状态
    ├── summary.json           # 当前 Agent 最终汇总
    ├── report.json            # Agent 与 ohosTest 指标明细
    ├── overview.html          # 当前 Agent 的完整报告（供根级总览下钻）
    ├── subpage/               # 各用例 HTML 详情页
    └── <caseName>/
        ├── base/ 或 task/         # Agent 修改后的工程，也是 ohosTest 的 base_project
        ├── state.json             # 单用例状态
        ├── session.json           # OpenCode session 信息
        ├── metadata.json          # Agent 完成后从源 case 原样复制
        ├── test_patch.patch       # Agent 完成后从源 case复制
        ├── result.json            # 单用例最终结果
        ├── whitebox/              # 白盒评价输入、结果、日志和单文件 HTML
        ├── .ohostest-runs/        # harmonyos-ohostest-runner 自动生成
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
            ├── compile-attempts.json # Agent build attempt details; excludes ohosTest
            ├── skill-runtime.json    # 授权 Skill 路径和预装记录（不含 Provider 凭据）
            └── skill-workflow.json   # 一多 Skill 的账本、状态、报告完整性检查
```

白盒评价从源用例的 `PROMPT.md` 直接读取原始 Prompt，不从 Agent 消息或 ohosTest 元数据反推。`original-prompt.md` 保留原文，`effective-prompt.md` 是实际交给裁判的版本；当 `prompt.includeAdditionalPrompt=true` 时，后者会追加 `execution.additionalPrompt`。运行时系统约束、隐藏测试 Patch、golden patch 和 ohosTest 测试名不会进入裁判 Sandbox。

Agent 结束后，Autorun 会在业务 Patch 和白盒 Sandbox 边界排除 `.onemulti/`、`__pycache__/`、`*.pyc` 和 `**/evidence/tmp/`，并从生成工程中清理后三类临时产物。`.onemulti/` 的正式内容保留在生成工程中并打包进用例 ZIP，供分发和排查；它仍不属于业务交付差异，ohosTest Runner 复制测试工程时也会独立排除该目录，不依赖工程 `.gitignore`。

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
        -> completed | failed | timed_out | rate_limited | interrupted
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

确认当前来源的 `resources/opencode/opencode.json` 中存在对应模型配置，并确认修改后已经重启 OpenCode Server。`harmonyBot` 模式还需确认对应 Agent 和 Plugin 完整；permission 会由 Autorun 的运行时配置统一覆盖为 `allow`。`softwareEngineering` 不要求自定义 Agent 或 Plugin，使用内置 `build` Agent；除来源 Skill 精确白名单外，其余工具权限保持 `allow`。

### 一多适配任务没有调用 Skill

`harmonyos-multi-device` 正常启动时会加载插件注入的 Agent prompt，并注册 `harmonyos-ui-multi` Skill。Autorun 会在执行用例前检查这两项及脚本/CLI 依赖，并在会话前预装 Skill；如果缺少 `devecocli`、Python 版本不够或脚本失效，会直接报错，不再让 Agent 自行降级为手工流程。查看 `generate/input.txt` 中的授权工具路径、`generate/skill-runtime.json` 的预装记录及 `generate/skill-workflow.json` 的产物校验结果。修改代码后需要重启 Autorun；旧会话不会自动更新提示词或预装状态。

自动启动 Server 时，Autorun 会复制来源 `opencode.json` 和 Skill、Plugin、Provider 到 `<batchId>/<agentId>` 对应的私有 runtime，强制全局及 Agent 的运行工具权限为 `allow`。`softwareEngineering` 的 Skill 权限例外采用来源精确白名单。运行数据、数据库、配置、状态和缓存均不跨 Agent 复用；配置端口已占用时会自动选择其他端口。

### 提示 Server 未强制全部权限 allow

说明运行时有效配置仍存在 `ask` 或 `deny`，可能来自 Agent 级覆盖或 Plugin 注入。Autorun 不会在这种状态下执行用例；检查运行日志中的实际配置来源，并重新启动 Server。

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

### 用例状态显示「限额」（API 限额）

Autorun 实时监听 OpenCode SSE 的 `session.status` 事件，模型 API 返回限额提示时按两类处理：

- **周期用量上限**：消息含「每周/每月使用上限」「限额将在 … 重置」等（如 `您已达到每周/每月使用上限，您的限额将在 2026-08-26 10:01:54 重置。`）。重置时间之前限额不会恢复，继续等待只会耗到空闲超时，因此检测到后立即中止主/子 session，用例状态标记为 `rate_limited`，终端生成状态列和 HTML 报告显示「限额」，「当前操作」列会提示原始限额消息。
- **瞬时限流**：普通 429 / rate limit，通常短时间内自行恢复，继续交给 OpenCode 重试并提示「检测到 API 限流，等待恢复」；若最终仍因限流失败，同样标记为 `rate_limited`。

判定依据保留在 `generate/opencode-sse.jsonl`，`result.json` 中记录 `quotaLimited: true`，`agentError` 含原始限额消息与重置时间。限额属于账号级问题：并发中的其他用例和后续用例通常会在各自首个模型请求时同样快速失败为「限额」，是否继续执行剩余队列由 `execution.continueOnError`（默认 `true`）决定。处理方式：等待配额重置（以限额消息中的重置时间为准）、更换 API Key 或提升配额后，使用「重试失败用例」重新执行。

### API 请求返回 401、403 或模型不可用

检查 OpenCode Provider 的 API Key、账户权限、余额、模型 ID 和网络连接。不要把 API Key 提交到公共代码仓库。
