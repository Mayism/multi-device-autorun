# Muti-Device-Autorun

Autorun 是一个面向 OpenCode Agent 的批量自动执行工具。它会自动启动或复用 OpenCode Server，扫描 `cases/` 下的用例，并通过固定并发的 Worker Pool 持续执行任务。

每个用例都使用独立的 OpenCode session、工程副本和结果目录。Agent 不会直接修改 `cases/<case>/base/` 中的原始工程。

## 主要功能

- 自动启动或复用 OpenCode Server。
- 支持 Windows、macOS 和 Linux 的 Node.js 运行环境。
- 自动扫描 `cases/` 下的可执行用例。
- 从每个用例的 `PROMPT.md` 读取任务提示词。
- 通过可配置的 Worker Pool 并行执行多个用例。
- 任意用例完成后立即领取下一个待执行用例，不等待同批其他用例结束。
- 每个用例创建独立的 OpenCode session、`original/` 和 `base/`；Agent 从开始到结束都在运行目录的 `base/` 中工作。
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

目前主流程只负责 Agent 执行和产物归档。使用生成工程继续执行编译、测试、设备验证等后续任务的能力将在后续版本补充。

## 环境要求

- Node.js 20 或更高版本，推荐使用当前 LTS 版本。
- Git，需要能够从命令行执行 `git`。
- DevEco Studio 及对应 HarmonyOS SDK、Node、ohpm 和 hvigor 工具链。
- VS Code 扩展目录下已安装名称前缀为 `huaweideveloperserviceplatform.harmonyosdevassistantforvscode` 的扩展；扩展内需包含当前平台对应的 OpenCode 二进制、配置、Agent、Plugin 和 Skill。
- OpenCode 配置中存在可用的模型 Provider 和 API 凭据。

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
    ├── base/                   # 原始工程，Autorun 不会直接修改
    ├── PROMPT.md               # Agent 任务提示词
    ├── metadata.json           # ohosTest case 元数据
    ├── test_patch.patch        # 测试补丁
    └── golden_patch.patch      # swe 模式不应用，但 Runner 加载配置时要求存在
```

缺少 `base/` 或 `PROMPT.md` 的目录不会进入 Agent 执行队列。启用 ohosTest 后，还必须存在合法的 `metadata.json` 及其引用的两个 patch。`PROMPT.md` 应使用 UTF-8 编码且内容不能为空。

## 配置

核心配置位于 `config/autorun.config.json`。标准 JSON 不支持注释，各配置项的说明见下方表格。

```json
{
  "server": {
    "url": "http://127.0.0.1:61419",
    "vscodeExtensionsRoot": "C:\\Users\\HW\\.vscode\\extensions",
    "devecoHome": "D:\\deveco\\DevEco Studio",
    "stopWhenFinished": true
  },
  "execution": {
    "casesRoot": "../cases",
    "outputRoot": "../output",
    "agent": "harmonyos-multi-device",
    "model": "deepseek-v4-flash",
    "concurrency": 3,
    "idleTimeoutSec": 600,
    "maxRuntimeSec": 6000,
    "continueOnError": true
  },
  "ohosTest": {
    "enabled": true,
    "runnerRoot": "D:\\tool\\harmonyos-ohostest\\harmonyos-ohostest-runner",
    "timeoutSec": 7200
  }
}
```

主要配置说明：

| 配置 | 说明 |
| --- | --- |
| `server.url` | OpenCode Server 地址。地址不可用时会自动启动 Server。 |
| `server.vscodeExtensionsRoot` | VS Code 扩展根目录。程序按固定扩展名前缀匹配，并优先使用版本最高且资源完整的扩展。 |
| `server.devecoHome` | DevEco Studio 安装目录。也可以用 `DEVECO_HOME` 环境变量覆盖。 |
| `server.stopWhenFinished` | 是否关闭本次 Autorun 自动启动的 Server。启动前已存在的 Server 不会被关闭。 |
| `execution.casesRoot` | 用例根目录。 |
| `execution.outputRoot` | 批次、工程副本、报告及 OpenCode 运行数据的输出根目录。Windows 下使用 Hvigor 时建议配置成 `D:/out`、`D:/ar` 等尽可能短的绝对路径，降低 259 字符路径上限导致的构建失败风险。默认是项目内的 `../output`。 |
| `execution.agent` | OpenCode Agent 名称。 |
| `execution.model` | 模型 ID。程序会从 Server `/config` 自动解析 Provider。 |
| `execution.concurrency` | 同时运行的 Agent 数量。任意任务结束后立即补充下一个任务。 |
| `execution.consoleMode` | 控制台模式：`dashboard`（默认动态看板）、`summary`（仅开始/结束）或 `verbose`（逐条进度）。非交互输出会自动退化为 `summary`。 |
| `execution.idleTimeoutSec` | Agent 连续无活动的超时时间。 |
| `execution.maxRuntimeSec` | 单个用例最大总运行时间。 |
| `execution.continueOnError` | 单个用例失败后是否继续执行剩余用例。 |
| `ohosTest.enabled` | 是否在 Agent 适配完成后自动执行 `npm run ohostest:case`。 |
| `ohosTest.runnerRoot` | 本机 `harmonyos-ohostest-runner` 仓库路径，该目录需已执行 `npm install`。 |
| `ohosTest.timeoutSec` | 单个 ohosTest 用例的最大运行时间，超时后终止 Runner 及其子进程。 |

相对路径以 `config/autorun.config.json` 所在目录为基准解析。

### Windows/Hvigor 输出路径建议

Autorun 会在 `outputRoot/<batchId>/<caseName>/base` 下创建实际参与 Agent 编译的工程。Hvigor 对部分构建路径执行 259 字符限制检查；工程中的 `build/cache/oh_modules/.ohpm` 会继续扩展多层目录，因此 Windows 下建议将 `execution.outputRoot` 配置成短的绝对路径：

```json
{
  "execution": {
    "casesRoot": "D:/multi-device-autorun/cases",
    "outputRoot": "D:/out"
  }
}
```

修改后，批次报告和详细结果也会写入 `D:/out/<batchId>/`，OpenCode 运行数据默认写入 `D:/out/_runtime/opencode/`。仅开启 Windows 长路径或设置 `git core.longpaths` 不能绕过 Hvigor 自身的 Specification Limit 检查；如果用例名、模块名或依赖内部路径本身很长，应继续缩短 `outputRoot`，并尽量缩短用例、模块和 target 名称。

### macOS 配置示例

可以直接修改 `devecoHome`，也可以通过环境变量覆盖：

```bash
export DEVECO_HOME="/Applications/DevEco-Studio.app"
node autorun.mjs
```

macOS 还需把 `server.vscodeExtensionsRoot` 改为本机扩展目录，例如 `/Users/<用户名>/.vscode/extensions`；匹配到的扩展中需要存在当前 macOS 架构对应的 OpenCode 二进制。

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

### 3. 单任务调试

确保 OpenCode Server 已运行，然后执行：

```powershell
node src/ask-opencode.mjs "帮我把当前工程下的文件名列出来" --agent harmonyos-multi-device --model deepseek-v4-flash -C "D:\autorun\cases\CaseHomeStay"
```

查看单任务参数：

```bash
node src/ask-opencode.mjs --help
```

### 4. 单独启动 OpenCode Server

通常不需要手工启动 Server。如果需要排查 Server 启动问题，可以执行：

```bash
node src/run-opencode-serve.mjs --settings ./config/autorun.config.json --workspace .
```

脚本会从配置的 VS Code 扩展目录定位 OpenCode 资源，并把运行数据统一写到 `output/_runtime/opencode/`。也可以用 `--source`、`--runtime-root`、`--port` 和 `--deveco-home` 分别覆盖资源、运行目录、端口和 DevEco Studio 路径。

默认启动和 Autorun 自动启动都不会创建或写入旧的 `opencode/run/`。已有旧目录不会自动删除，以保留历史会话；确认不再需要后可手工归档或删除。

查看完整参数：

```bash
node src/run-opencode-serve.mjs --help
```

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

Agent 运行期间，结果目录中只有工程和 Agent 自身产物，不会放入 `metadata.json`、`test_patch.patch` 或 `golden_patch.patch`。Agent 完成后，Autorun 才把源 case 的 metadata 和两个 patch 原样复制到 `output/<batchId>/<caseName>/`，并执行 `ohostest:case --run swe`。此时 Runner 以 Agent 修改后的 `base/` 为候选工程，只应用 `test_patch.patch`，不会应用 `golden_patch.patch`。Autorun 不传 `--out` 和 `--machine-config`：结果目录由 Runner 默认创建，设备配置由 Runner 工作目录下的 `config/machine.json` 提供。

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
    ├── base/                  # Agent 修改后的工程，也是 ohosTest 的 base_project
    ├── state.json             # 单用例状态
    ├── session.json           # OpenCode session 信息
    ├── metadata.json          # Agent 完成后从源 case 原样复制
    ├── test_patch.patch       # Agent 完成后从源 case复制
    ├── golden_patch.patch     # Agent 完成后从源 case复制，swe 模式不应用
    ├── result.json            # 单用例最终结果
    ├── execution.jsonl        # 任务执行事件
    ├── ohostest-runner-console.log # Runner 标准输出和错误输出
    ├── .ohostest-runs/        # harmonyos-ohostest-runner 自动生成
    │   └── <timestamp>/
    │       ├── result.json
    │       ├── summary.md
    │       └── commands.jsonl
    ├── diff/
    │   └── changes.patch      # 相对于 base 工程初始 Git 基线的 Agent 变更
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

`result.json` 使用 `projectDir` 记录 Agent 最终工程的 `base/` 绝对路径，并直接包含 Agent 的最终回复 `output`；`tokenUsage` 记录输入、输出、reasoning、缓存、总 Token 和 cost，`ohosTest` 记录测试状态、耗时及 Runner 原生结果路径，`logs` 列出完整输出、原始消息、SSE、轮询、执行日志和 Runner 控制台日志路径。`summary.json` 同时保存全批次 Token 汇总和各用例 ohosTest 结果。为避免 `result.json` 过大，完整过程不会重复内嵌其中；查看 `generate/agent-output.log` 即可阅读完整 Agent 过程。

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

- `server.vscodeExtensionsRoot` 是否正确，以及匹配到的扩展内 `resources/opencode/` 是否完整；
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

确认匹配到的 VS Code 扩展的 `resources/opencode/opencode.json` 中存在对应 Agent 和模型，并确认修改配置后已经重启 OpenCode Server。

### 一多适配任务没有调用 Skill

`harmonyos-multi-device` 正常启动时会加载插件注入的 Agent prompt，并注册 `harmonyos-adaptation-workflow`、`harmonyos-responsive-layout` 等 Skill。Autorun 会在执行用例前检查这两项；如果插件或 Skill 的运行时路径失效，会直接报错而不再静默执行。

自动启动 Server 时，Autorun 会把 bundled `plugin/`、`skills/` 映射到运行配置目录。若复用了修复前启动的旧 Server，请先停止旧 Server，再重新执行 `node autorun.mjs`。

### 提示 `external_directory=deny` 未生效

运行中的 Server 可能仍使用修改前的配置。停止旧 Server 后重新执行 `node autorun.mjs`，让 Autorun 自动启动并重新加载配置。

### 没有发现可执行用例

确认每个用例是 `casesRoot` 的直接子目录，并同时包含：

```text
base/
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

可以适当调整 `idleTimeoutSec` 和 `maxRuntimeSec`。超时后 Autorun 会尝试中止主 session 和子 session，并保留最后消息和 `base/` 工程。

当 Agent 发生空闲或总时长超时时，Autorun 仍会把已生成的 `base/` 工程和 `changes.patch` 放入串行 ohostest 队列。最终用例状态由 ohostest 决定：其编译或执行失败会显示为失败/超时；若测试通过，则显示完成，并在 `result.json` 中保留 `agentStatus: "timed_out"` 与 `agentError` 供追溯。用户主动中断批次时不会再启动 ohostest。

所有 `hvigorw` 命令（包括 `tasks`）都应使用 `--no-daemon`，例如：

```powershell
hvigorw.bat tasks --no-daemon
```

### 批次或用例一直显示 running，但进程已经结束

Autorun 会在正常可捕获的中断中把正在执行的用例标记为 `interrupted`，尚未开始的用例标记为 `cancelled`，并写入 `result.json` 和批次 `summary.json`。

对于任务管理器强制结束、断电等无法现场收尾的情况，下次执行 `node autorun.mjs` 或 `node autorun.mjs --check` 时会扫描工程内的 `output/`，将遗留批次标记为 `interrupted`。已完成、失败或超时的用例状态不会被覆盖。

### API 请求返回 401、403 或模型不可用

检查 OpenCode Provider 的 API Key、账户权限、余额、模型 ID 和网络连接。不要把 API Key 提交到公共代码仓库。
