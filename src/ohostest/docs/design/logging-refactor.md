# Runner JSONL 日志子系统设计

## 1. 目标

Runner 抽离独立日志子系统，统一记录命令执行和运行异常。

日志子系统满足以下要求：

- 使用 Pino 输出 JSONL。
- case 和 matrix 每次运行只生成一个顶层日志文件。
- 配置文件读取、解析和校验失败时记录具体文件及错误上下文。
- 最终异常同时写入 `result.json` 和顶层日志。
- 命令输出按 `phase`、`deviceId` 和 `suiteClass` 区分来源。
- 保持 `result.json` 现有日志路径字段可用。
- 日志只保留可用于定位问题或判断执行结果的信息。

## 2. 依赖

生产依赖使用 Pino 10。

```json
{
  "dependencies": {
    "pino": "^10.0.0"
  }
}
```

Pino 负责 JSONL 序列化、时间戳和错误对象序列化。Runner 日志子系统负责事件结构、上下文绑定和生命周期管理。

根日志实例关闭 Pino 默认基础字段，避免写入单机运行中没有排障价值的 `pid` 和 `hostname`：

```ts
pino(
  {
    base: undefined,
  },
  destination,
);
```

## 3. 输出结构

### 3.1 Case 运行

```text
<case-output>/
├── commands.jsonl
├── result.json
├── summary.md
├── swe/
│   ├── result.json
│   └── summary.md
└── answer/
    ├── result.json
    └── summary.md
```

`swe` 和 `answer` 阶段共用顶层 `commands.jsonl`，不创建阶段级命令日志。

### 3.2 Matrix 运行

```text
<matrix-output>/
├── commands.jsonl
├── result.json
└── summary.md
```

设备执行信息只写入 `commands.jsonl`。

## 4. 代码结构

新增日志子系统目录：

```text
src/logging/
├── logger.ts
├── command.ts
└── types.ts
```

各文件职责如下：

- `logger.ts`：创建 Pino destination、管理根日志实例、创建带上下文的子日志实例、写入标准事件。
- `command.ts`：包装 `CommandExecutor`，统一记录命令结果和命令执行异常。
- `types.ts`：定义日志上下文和日志事件类型。

命令执行能力继续保留在 `src/execution/command.ts`：

- `defaultCommandExecutor`
- `runDetachedCommand`
- `decode`

日志子系统不负责执行命令，只观察并记录命令执行结果。

## 5. 日志接口

```ts
export type LogPhase = "case" | "matrix" | "swe" | "answer";

export interface LogBindings {
  phase?: LogPhase;
  deviceId?: string;
  suiteClass?: string;
}

export interface ErrorContext {
  errorCode?: string;
  file?: string;
  command?: string;
}

export class RunnerLogger {
  static create(logPath: string, bindings?: LogBindings): RunnerLogger;

  child(bindings: LogBindings): RunnerLogger;

  recordCommand(command: string, result: CommandResult): void;

  recordError(error: unknown, context?: ErrorContext): void;

  get logPath(): string;

  close(): Promise<void>;
}

export function createLoggedCommandExecutor(
  executor: CommandExecutor,
  logger: RunnerLogger,
  cwd: string,
): CommandExecutor;
```

根日志实例拥有 destination，并负责关闭日志文件。子日志实例共享同一 destination，只增加上下文字段。

## 6. 日志事件

定义四类事件：

- `command`
- `runner_error`
- `test_case`
- `test_suite`

### 6.1 command

```json
{
  "level": 30,
  "time": 1785400000000,
  "event": "command",
  "phase": "swe",
  "deviceId": "phone",
  "suiteClass": "ExampleTest",
  "command": "hdc -t emulator-5554 shell aa test ...",
  "exitCode": 0,
  "durationMs": 1320,
  "stdout": "..."
}
```

字段：

- `phase`：命令所属阶段。
- `deviceId`：设备相关命令的设备标识。
- `suiteClass`：测试命令对应的测试套件。
- `command`：执行的命令。
- `exitCode`：命令退出码。
- `durationMs`：命令执行耗时。
- `stdout`、`stderr`：命令输出。

命令退出码非零时使用 `error` 级别，其余命令使用 `info` 级别。

`stdout` 和 `stderr` 为空时不写入对应字段。写入非空输出前，使用 Node.js 的 `stripVTControlCharacters` 移除 ANSI 终端控制序列。

日志不写入标题、命令序号和 `$` 命令提示符。JSONL 行顺序和 `time` 字段用于表达执行顺序。

设备连接和断开等待中的 `hdc list targets` 只记录终止轮询的最后一次命令结果：

- 达到预期连接状态时记录最后一次命令结果。
- 等待超时时记录最后一次命令结果，并由超时处理边界记录 `runner_error`。

轮询过程中的中间结果不写入日志。其他命令即使内容相同，也按实际执行阶段分别记录。

成功解析 `aa test` 输出后，命令事件不再重复保存整段 OHOS 状态协议；
用例结果和 suite 汇总分别写入 `test_case` 与 `test_suite` 事件。解析失败时保留
原始命令输出用于排障。

### 6.2 runner_error

```json
{
  "level": 50,
  "time": 1785400001000,
  "event": "runner_error",
  "phase": "case",
  "errorCode": "CONFIG_PARSE_ERROR",
  "file": "/workspace/case/build-profile.json5",
  "err": {
    "type": "SyntaxError",
    "message": "JSON5: invalid character at 4:8",
    "stack": "..."
  }
}
```

字段：

- `phase`：异常发生阶段。
- `errorCode`：稳定的错误分类。
- `file`：异常关联的配置文件绝对路径。
- `command`：异常关联的命令。
- `err`：Pino 标准错误对象。

配置文件相关异常在读取、解析或校验边界补充 `file` 和 `errorCode` 后记录。

### 6.3 test_case

每个测试用例写入独立事件，包含 `test`、`status`、`statusCode`，以及可用的
`durationMs`。失败用例额外包含 Hypium 输出的 `message` 和 `stack`，并使用
`error` 级别。

### 6.4 test_suite

每个 suite 写入汇总事件，包含状态、执行数、失败数、错误数、通过数、忽略数和
`reportCode`。

## 7. 生命周期与上下文

### 7.1 Case

`runOhosTestCase` 在读取 `metadata.json` 前创建根日志实例：

```ts
const logger = RunnerLogger.create(commandsLogPath, { phase: "case" });
```

阶段执行使用子日志实例：

```ts
await runExecution({
  ...input,
  logger: logger.child({ phase: "swe" }),
});

await runExecution({
  ...input,
  logger: logger.child({ phase: "answer" }),
});
```

设备和测试套件继续通过子日志实例绑定：

```ts
const deviceLogger = logger.child({ deviceId });
const suiteLogger = deviceLogger.child({ suiteClass });
```

`runOhosTestCase` 在结果和清理流程结束后关闭根日志实例。日志关闭放在 `finally` 中执行。

### 7.2 Matrix

`runOhosTestMatrix` 在读取运行配置前创建根日志实例：

```ts
const logger = RunnerLogger.create(commandsLogPath, { phase: "matrix" });
```

matrix 内部的设备和套件执行使用同一组上下文绑定规则。

### 7.3 Execution

`runExecution` 接收调用方传入的 `RunnerLogger`：

```ts
export interface RunExecutionInput {
  // 现有字段
  logger: RunnerLogger;
}
```

`runExecution` 不创建日志文件，也不关闭日志实例。

设备状态轮询直接使用原始 `CommandExecutor` 并保留最后一次结果，轮询终止时调用 `recordCommand`。该规则在设备等待逻辑内部实现，不扩展通用日志接口。

## 8. 异常记录

日志子系统按以下边界记录信息：

- 命令包装器记录执行器返回的命令结果，设备就绪轮询按第 6.1 节的规则记录。
- 配置读取模块为读取、解析和校验异常补充文件路径及错误分类，然后继续向上抛出。
- case 和 matrix 顶层捕获边界记录最终抛出的异常。
- 未通过抛出异常表达、但会写入失败结果的运行错误，在转换为结果的边界记录。

一个异常只由一个边界负责写入日志。内部函数补充错误上下文时不写日志，避免异常逐层传播时重复记录。

记录日志后继续沿用现有异常传播和 `result.json` 生成流程，不改变运行成功与失败的判定。

## 9. 结果文件中的日志路径

### 9.1 Case 顶层结果

```json
{
  "artifacts": {
    "commandLog": "commands.jsonl"
  }
}
```

### 9.2 Case 阶段结果

`swe/result.json` 和 `answer/result.json` 指向顶层日志：

```json
{
  "artifacts": {
    "commandLog": "../commands.jsonl"
  }
}
```

### 9.3 设备结果

保留 `DeviceRunResult.log` 字段，并指向共享日志：

- matrix 结果使用 `commands.jsonl`。
- case 阶段结果使用 `../commands.jsonl`。

调用方使用设备结果中的 `deviceId` 过滤共享日志里的同名字段。

## 10. 清理规则

复用输出目录时，Pino destination 以覆盖模式创建顶层
`commands.jsonl`，确保每次运行只保留本次事件。

## 11. CLI 输出

运行失败时，CLI 的 `stderr` 输出：

```text
Runner failed: <错误摘要>
Log: <commands.jsonl 绝对路径>
Result: <result.json 绝对路径>
```

错误摘要优先包含：

- 错误分类。
- 配置文件路径。
- 原始错误信息。

## 12. 修改范围

实现涉及以下模块：

- `src/logging/logger.ts`
- `src/logging/command.ts`
- `src/logging/types.ts`
- `src/case/runner.ts`
- `src/execution/runner.ts`
- `src/execution/device.ts`
- `src/execution/command.ts`
- `src/matrix/runner.ts`
- `src/configFile.ts`
- `src/types.ts`
- CLI 入口
- 相关单元测试和集成测试

## 13. 验收标准

- case 运行只生成一个顶层 `commands.jsonl`。
- matrix 运行只生成一个顶层 `commands.jsonl`。
- 不生成阶段级或设备级日志文件。
- `commands.jsonl` 每行都是可独立解析的 JSON 对象。
- 所有命令记录包含 `phase`，设备命令包含 `deviceId`。
- 测试命令包含 `suiteClass`。
- 日志不包含 Pino 默认的 `pid` 和 `hostname`。
- 空的 `stdout`、`stderr` 不产生字段。
- 命令输出不包含 ANSI 终端控制序列。
- 每次设备连接或断开等待只记录最后一次 `hdc list targets`。
- 命令退出码非零时写入 `error` 级别事件。
- `metadata.json`、`build-profile.json5` 等配置错误包含具体文件路径。
- 最终异常同时出现在 `result.json`、`commands.jsonl` 和 CLI `stderr`。
- case、阶段、matrix 和设备结果中的日志路径均能解析到同一个顶层日志文件。
- 现有成功、失败和清理语义保持不变。
