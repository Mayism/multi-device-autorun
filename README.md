# Muti-Device-Autorun

Autorun 是一个面向 OpenCode Agent 的批量自动执行工具。它会自动启动或复用 OpenCode Server，扫描 `cases/` 下的用例，并通过固定并发的 Worker Pool 持续执行任务。

每个用例都使用独立的 OpenCode session、工程副本和结果目录。Agent 不会直接修改 `cases/<case>/base/` 或 `cases/<case>/task/` 中的原始工程。

## 主要功能

- 自动启动或复用 OpenCode Server。
- 支持 Windows、macOS 和 Linux 的 Node.js 运行环境。
- 自动扫描 `cases/` 下的可执行用例。
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
├── cases/                      # 原始用例
└── output/
    ├── _runtime/opencode/      # OpenCode Server 运行数据和日志
    └── <batchId>/              # 正式批量运行结果
```

工程仅提供 `.mjs` 入口；在安装 Node.js 的 Windows、macOS 和 Linux 环境中均可运行。当前自动化主链不会依赖平台专用的 `.bat`、`.ps1` 或 `.sh` 脚本。

## 用例格式

`cases/` 的每个直接子目录代表一个用例。一个可执行用例至少需要包含：

```text
cases/
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
    "stopWhenFinished": true,
    "loadAgents": []
  },
  "execution": {
    "casesRoot": "../cases",
    "outputRoot": "../output",
    "agent": "harmonyos-multi-device",
    "model": "deepseek-v4-flash",
    "additionalPrompt": "",
    "concurrency": 3,
    "idleTimeoutSec": 600,
    "maxRuntimeSec": 6000,
    "continueOnError": true
  },
  "ohosTest": {
    "enabled": true,
    "runnerRoot": "D:\\tool\\harmonyos-ohostest\\harmonyos-ohostest-runner",
    "timeoutSec": 7200
  },
  "upload": {
    "enabled": false
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
| `server.stopWhenFinished` | 是否关闭本次 Autorun 自动启动的 Server。启动前已存在的 Server 不会被关闭。 |
| `server.loadAgents` | 指定自动启动的 Server 只加载这些 Agent（字符串数组）。留空（默认）加载 `opencode.json` 中的全部 Agent；配置后仅加载列出的 Agent，且 `execution.agent` 必须在列表中，否则启动即报错中止并提示修改配置。仅对 Autorun 自动启动的 Server 生效；复用已运行的 Server 时不重新过滤。 |
| `execution.casesRoot` | 用例根目录。 |
| `execution.outputRoot` | 批次、工程副本、报告及 OpenCode 运行数据的输出根目录。Windows 下使用 Hvigor 时建议配置成 `D:/out`、`D:/ar` 等尽可能短的绝对路径，降低 259 字符路径上限导致的构建失败风险。默认是项目内的 `../output`。 |
| `execution.agent` | `harmonyBot` 模式使用的 OpenCode Agent 名称。`softwareEngineering` 只有 Skills，固定使用 OpenCode 内置 `build` Agent，该字段在该模式下会被忽略。 |
| `execution.model` | 模型 ID。程序会从 Server `/config` 自动解析 Provider。 |
| `execution.additionalPrompt` | 统一追加到每个用例 `PROMPT.md` 内容后的提示词。未配置、空字符串或仅包含空白时不追加；不会修改源用例文件，实际发送内容可在用例输出的 `generate/input.txt` 中核对。 |
| `execution.concurrency` | 同时运行的 Agent 数量。任意任务结束后立即补充下一个任务。 |
| `execution.consoleMode` | 控制台模式：`dashboard`（默认动态看板）、`summary`（仅开始/结束）或 `verbose`（逐条进度）。非交互输出会自动退化为 `summary`。 |
| `execution.idleTimeoutSec` | Agent 连续无活动的超时时间。 |
| `execution.maxRuntimeSec` | 单个用例最大总运行时间。 |
| `execution.continueOnError` | 单个用例失败后是否继续执行剩余用例。 |
| `ohosTest.enabled` | 是否在 Agent 适配完成后自动执行 `npm run ohostest:case`。 |
| `ohosTest.runnerRoot` | 本机 `harmonyos-ohostest-runner` 仓库路径，该目录需已执行 `npm install`。 |
| `ohosTest.timeoutSec` | 单个 ohosTest 用例的最大运行时间，超时后终止 Runner 及其子进程。 |
| `upload.enabled` | 是否在批次完成后自动将失败用例产物上传到 AGC 云存储。默认 `false`（仅打包 ZIP 到用例目录，不上传、不写 `upload-results.json`、HTML 不显示下载按钮）。设为 `true` 后上传成功写 `upload-results.json` 并在总览页显示下载按钮。上传凭证已内置在代码中，无需额外配置。 |

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

Autorun 会在 `outputRoot/<batchId>/<caseName>/<base|task>` 下创建实际参与 Agent 编译的工程。Hvigor 对部分构建路径执行 259 字符限制检查；工程中的 `build/cache/oh_modules/.ohpm` 会继续扩展多层目录，因此 Windows 下建议将 `execution.outputRoot` 配置成短的绝对路径：

```json
{
  "execution": {
    "casesRoot": "D:/multi-device-autorun/cases",
    "outputRoot": "D:/out"
  }
}
```

修改后，批次报告和详细结果也会写入 `D:/out/<batchId>/`，OpenCode 运行数据默认写入 `D:/out/_runtime/opencode/`。仅开启 Windows 长路径或设置 `git core.longpaths` 不能绕过 Hvigor 自身的 Specification Limit 检查；如果用例名、模块名或依赖内部路径本身很长，应继续缩短 `outputRoot`，并尽量缩短用例、模块和 target 名称。

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

重试历史批次中所有失败、中断或未执行的用例：

```bash
node autorun.mjs --retry 20260810_095119_d87e1ad0
```

只重试该批次中的某一个用例：

```bash
node autorun.mjs --retry 20260810_095119_d87e1ad0 --case CaseAtomic
```

重试会创建一个新批次，不覆盖原批次。若历史结果中 Agent 已成功且工程、`changes.patch` 仍然存在，则复用 Agent 结果并只重新执行 ohosTest；Agent 未成功或历史产物已不存在时会重新执行 Agent，成功后再进入 ohosTest。显式指定 `--case` 时允许重试已成功用例，此时同样优先复用成功的 Agent 结果，只重新执行 ohosTest。

### 4. 单任务调试

确保 OpenCode Server 已运行，然后执行：

```powershell
node src/ask-opencode.mjs "帮我把当前工程下的文件名列出来" --agent harmonyos-multi-device --model deepseek-v4-flash -C "D:\autorun\cases\CaseHomeStay"
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

Agent 运行期间，结果目录中只有工程和 Agent 自身产物，不会放入 `metadata.json`、`test_patch.patch` 或 `golden_patch.patch`。Agent 完成后，Autorun 才把源 case 的 metadata 和两个 patch 原样复制到 `output/<batchId>/<caseName>/`，并执行 `ohostest:case --run swe`。此时 Runner 以 Agent 修改后的 `base/` 或 `task/` 为候选工程，只应用 `test_patch.patch`，不会应用 `golden_patch.patch`。Autorun 不传 `--out` 和 `--machine-config`：结果目录由 Runner 默认创建，设备配置由 Runner 工作目录下的 `config/machine.json` 提供。

Agent 的实际提示词会追加工作目录隔离要求，禁止枚举或读取当前工程以外的用例和评测文件。工程复制会排除 `.hvigor`、`build`、`node_modules` 等缓存/产物，避免历史构建日志泄漏源 case 路径。OpenCode Server 同时保持 `external_directory=deny`。

当前版本只扫描启动时已经存在的用例。运行过程中新增到 `casesRoot` 的用例需要在下一次启动时执行。

## 运行结果

每次正式执行会创建独立批次目录：

```text
output/<batchId>/
├── batch.json                 # 当前批次和所有用例状态
├── summary.json               # 批次最终汇总
└── <caseName>/
    ├── original/              # 原始工程副本
    ├── base/ 或 task/         # Agent 修改后的工程，也是 ohosTest 的 base_project
    ├── state.json             # 单用例状态
    ├── session.json           # OpenCode session 信息
    ├── metadata.json          # Agent 完成后从源 case 原样复制
    ├── test_patch.patch       # Agent 完成后从源 case复制
    ├── golden_patch.patch     # Agent 完成后从源 case复制，swe 模式不应用
    ├── result.json            # 单用例最终结果
    ├── execution.jsonl        # 任务执行事件
    ├── ohostest-runner-console.log # Runner 标准输出和错误输出
    ├── .ohostest-runs/        # harmonyos-ohostest-runner 自动生成
    │   └── <runId>/
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
        ├── opencode-sse.jsonl
        ├── opencode-polling.jsonl
        └── compile-attempts.json # Agent build attempt details; excludes ohosTest
```

ohosTest 执行期间会先创建 `<caseName>/work/` 作为实际编译工程；执行结束后统一重命名并保留为
`<caseName>/ohostest-workdir/`。用例 `result.json` 的 `ohosTest.workDir` 会记录其绝对路径。
该目录包含完整工程和构建缓存，便于定位问题，但会明显增加批次结果占用的磁盘空间，可在排查结束后手动删除。

`result.json` 使用 `projectName` 和 `projectDir` 记录 Agent 最终工程名及其绝对路径，并直接包含 Agent 的最终回复 `output`；`tokenUsage` 记录输入、输出、reasoning、缓存、总 Token 和 cost，`ohosTest` 记录测试状态、耗时及 Runner 原生结果路径，`logs` 列出完整输出、原始消息、SSE、轮询、执行日志和 Runner 控制台日志路径。`summary.json` 同时保存批次使用的 `agent`、`providerId`、`modelId`、全批次 Token 汇总和各用例 ohosTest 结果。为避免 `result.json` 过大，完整过程不会重复内嵌其中；查看 `generate/agent-output.log` 即可阅读完整 Agent 过程。

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

部分 HarmonyOS 工程会在 `oh_modules` 中使用 Windows Junction。Autorun 会在复制用例时自动把这类目录联接重映射到当前运行沙箱，不需要管理员权限，也不会让链接指回 `cases` 原始工程。

如果仍出现该错误，请确认使用的是包含 `src/lib/sandbox-copy.mjs` 的当前版本，并重新启动 `node autorun.mjs`。已经启动的 Node 进程不会加载后续代码修改；失败批次可以保留用于排查，重新运行会创建新的批次目录。

### Agent 长时间没有结束

控制台进度会区分“等待模型响应”“正在分析”“工具执行中”和“已生成回复”。监控会保留上一条有效操作；OpenCode 新建的空 `step-start` 消息不会再被误报成“等待首次模型输出”，也不会刷新空闲超时。Agent 在读取工程、搜索文件或修改源码时，工具状态、工具输出和 reasoning 的实际变化仍表示任务正在推进。

检查对应 case 的：

```text
generate/opencode-sse.jsonl
generate/opencode-polling.jsonl
execution.jsonl
```

可以适当调整 `idleTimeoutSec` 和 `maxRuntimeSec`。超时后 Autorun 会尝试中止主 session 和子 session，并保留最后消息和 `base/` 或 `task/` 工程。

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
