# 单用例 hilog 采集与失败日志输出设计

## 背景

当前 runner 通过 `hdc shell aa test` 执行 ohosTest。命令的 stdout/stderr 会在命令结束后整体写入 `commands.log` 和 `devices/<device>.log`，其中包含 Hypium 的 `OHOS_REPORT_STATUS` 记录。

现有实现存在以下限制：

- 没有执行 `hdc shell hilog`，因此测试代码和被测应用通过 `hilog` 或 `console.log` 产生的设备日志通常无法采集。
- `TestCaseRunResult` 只记录用例名称、状态和状态码，不能定位单个用例的日志。
- 命令执行器缓冲完整 stdout/stderr 后才返回，无法用 Hypium 的实时状态边界关联 hilog。
- CLI 只打印运行状态，不打印失败用例的诊断日志。

## 目标

1. 在 suite 执行期间采集当前被测包相关进程产生的 hilog。
2. 根据 Hypium 的实时用例开始、结束事件，将 hilog 关联到单个用例。
3. 完整日志始终落盘，默认只在终端打印失败用例的日志。
4. hilog 采集失败不得改变 ohosTest 的测试结果。
5. 使用 `ResponsiveRepeatLayout` 的 layout 用例进行一次真实设备或模拟器验证。

## 安全与范围约束

runner 不得启动未过滤的设备全量 hilog 采集。

每次 suite 执行时，runner 只采集当前工程 `bundleName` 对应的进程：

1. 在设备端使用 hilog 的 `-e` 正则过滤，只传输包含当前 `bundleName` 的候选日志。
2. runner 对每条候选日志再次解析进程名，只接受进程名等于 `bundleName`，或以 `<bundleName>:` 开头的日志。
3. 不匹配包名的日志不得写入 suite、用例或命令日志。
4. 正则参数必须对 `bundleName` 中的元字符转义，防止包名被解释为宽泛表达式。
5. 如果设备 hilog 不支持正则过滤、日志格式无法验证进程名，或过滤命令启动失败，则记录诊断并跳过该 suite 的 hilog；不得降级为设备全量采集。

`-e` 在设备端执行过滤；runner 不启动未带过滤条件的 hilog，再在主机端从设备全量日志中筛选。

## 方案比较

### 方案一：`aa test` 与过滤后的 hilog 双流实时关联

将 `aa test` stdout/stderr 改为流式读取，同时启动带当前包名正则条件的 hilog 流。收到 `OHOS_REPORT_STATUS_CODE: 1` 时打开用例窗口，收到该用例终态状态码时关闭窗口，窗口内通过包进程名复核的 hilog 归入对应用例。

优点：

- 保持现有按 suite 执行的效率。
- 能输出单用例日志。
- 不要求修改所有测试代码。
- 设备端和 runner 两层过滤可以严格限制为当前包进程。

缺点：

- `aa test` 和 hilog 是两个独立流，边界基于 runner 收到数据的时间，极少量异步日志可能落在相邻边界。
- suite 启动早期、包进程出现前的日志无法采集。

这是本设计采用的方案。

### 方案二：每个 suite 只采集一个日志文件

只按包进程过滤，不做单用例关联。

实现简单，但失败时只能打印整个 suite 的日志，无法满足单用例问题定位要求。

### 方案三：每个测试方法单独执行一次 `aa test`

每次只运行一个用例，天然获得隔离日志。

隔离更强，但会反复初始化应用和测试框架，显著增加矩阵耗时，并依赖 Hypium 方法级过滤在所有目标版本上的兼容性，因此不采用。

## 执行架构

### 流式命令执行

在保留现有 `CommandExecutor` 的基础上新增专用于长时间输出的流式执行能力：

```typescript
interface StreamingCommandCallbacks {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

interface RunningCommand {
  completed: Promise<CommandResult>;
  stop(): Promise<void>;
}
```

普通构建、安装和设备控制命令继续使用现有缓冲式执行器。只有 `aa test` 和 hilog 使用流式执行，避免扩大改动范围。

测试可以注入流式执行器，真实运行使用 `child_process.spawn`。命令日志在进程结束后仍通过 `CommandLogger` 记录完整结果。

### 包进程过滤

suite 启动时先构造经过正则转义的包名过滤条件，再启动一个 hilog 子进程：

- 设备端命令必须包含 `-e <escaped-bundle-name>`。
- runner 解析 hilog 标准输出中的进程字段。
- 只接受进程名等于 `bundleName` 或以 `<bundleName>:` 开头的日志。
- suite 完成后关闭 hilog 子进程。

hilog 正则过滤能力必须先经过真实目标环境能力探测。若当前 HarmonyOS 版本不支持 `-e`，应记录诊断并跳过采集；能力探测失败时遵循“不降级全量日志”的约束。

### 用例边界状态机

`aa test` stdout 可能按任意 chunk 到达，因此先使用行缓冲器还原完整行，再处理 Hypium 记录。

状态转换：

1. `OHOS_REPORT_STATUS: class=<suite>` 更新当前 suite。
2. `OHOS_REPORT_STATUS: test=<name>` 更新候选用例。
3. 随后的 `OHOS_REPORT_STATUS_CODE: 1` 打开该用例的日志窗口。
4. 同名用例随后的终态状态码关闭窗口：
   - `0`：passed
   - `-3`：ignored
   - 其他非 `1` 状态：failed
5. 窗口打开期间收到的、已经通过包名双层过滤的 hilog 行写入该用例。

如果 hilog 在没有活动用例时到达，只写入 suite 完整日志，不归入任何用例。runner 不猜测其归属。

### 时间与并发

每条 hilog 在 runner 收到时附加单调递增序号，并保留设备原始时间戳，保证文件输出稳定。

本 runner 当前按设备和 suite 串行执行，因此同一设备上最多只有一个活动 suite。若未来支持 suite 并行，必须为每个 suite 保持独立采集器，不得共享全局活动用例状态。

## 数据模型

扩展用例结果：

```typescript
interface TestCaseRunResult {
  name: string;
  status: TestCaseRunStatus;
  statusCode: number;
  logFile?: string;
  logExcerpt?: string[];
}
```

- `logFile`：相对当前矩阵输出目录的单用例 hilog 文件。
- `logExcerpt`：只保留用于终端打印的有限尾部行数，不包含完整日志。
- 完整日志不嵌入 `result.json`，避免报告体积失控。
- 没有日志、采集能力不可用或用例从未进入运行态时省略这两个字段。

## 输出结构

```text
<matrix-output>/
  result.json
  summary.md
  commands.log
  devices/
    <device>.log
    <device>/
      <suite>.hilog.log
      cases/
        <suite>/
          <test-case>.hilog.log
```

- `<suite>.hilog.log`：该 suite 中所有经过当前包名双层过滤的完整 hilog。
- 单用例文件：只包含用例活动窗口内的过滤后 hilog。
- 文件名继续使用现有 `sanitizeName()` 规则，防止非法路径字符。

空日志不创建单用例文件。suite 文件可以为空，用于明确表示采集已启用但没有匹配日志。

## 终端与报告

默认行为：

- passed 和 ignored 用例不打印 hilog。
- failed 用例在 suite 结束后打印名称、设备、suite、日志文件路径以及日志尾部摘录。
- 摘录设置固定最大行数；超出时显示省略提示。
- 如果失败用例没有捕获到 hilog，打印日志文件缺失或为空的提示，不影响失败状态。

`summary.md` 的用例表增加 `Log` 列，存在 `logFile` 时写相对链接。`result.json` 保存 `logFile` 和有限的 `logExcerpt`。

case 模式复用矩阵结果，不另建第二套采集逻辑。SWE 和 Answer 各自在自己的矩阵输出目录保存日志。

## 错误处理

下列问题只追加到 `MatrixResult.diagnostics`，不改变 suite 或用例状态：

- hilog 包名正则过滤能力不可用。
- hilog 输出无法解析或进程字段不属于当前包。
- hilog 子进程意外退出。
- 单个日志文件写入失败。

`aa test` 自身的启动、超时、退出码和输出解析仍沿用现有 blocked/failed 规则。

关闭 suite 时必须在 `finally` 中停止 hilog 子进程，避免残留后台采集。

## 测试策略

### 单元测试

1. 流式行缓冲能处理跨 chunk 的 `OHOS_REPORT_STATUS`。
2. 状态机只把运行窗口内的 hilog 分配给对应用例。
3. 相邻用例的日志不串用。
4. ignored、failed、passed 状态都能正确关闭窗口。
5. 进程名只接受 `bundleName` 和 `<bundleName>:` 前缀。
6. 包名正则会转义，过滤不可用时不会构造或启动全量 hilog 命令。
7. 日志文件路径经过清理并写入结果。
8. summary 只为存在日志的用例生成链接。
9. CLI 只打印失败用例摘录。

### 真实验证

在 `ResponsiveRepeatLayout` 的 `MdFailToPassTest` layout 用例中加入带唯一 tag 和文本的 `hilog`，例如包含：

```text
OHOSTEST_HILOG_PROBE MdFailToPassTest should_show_home_waterflow_as_multi_column_layout_on_medium_breakpoint
```

使用 foldable 配置执行一轮真实验证，并检查：

1. suite 完整日志包含唯一标记。
2. 标记只出现在目标用例日志，不出现在相邻用例日志。
3. 日志行的进程名属于当前工程 `bundleName` 或其子进程。
4. 采集产物不包含其他设备进程的日志。
5. 目标用例失败时终端打印摘录；若 Answer 轮通过，则另使用受控失败或单元测试验证失败打印路径。
6. `result.json` 和 `summary.md` 指向实际存在的日志文件。

真实验证优先只运行 foldable 和相关 suite，以缩短执行时间。验证结束后保留对定位有价值的 layout 用例 hilog，移除纯验证性临时改动。

## 非目标

- 不实现设备全量 hilog 归档。
- 不把任意系统进程日志归属给测试用例。
- 不保证应用在用例结束后异步产生的日志仍归入已关闭用例。
- 不改变 Hypium 测试代码的通用写法。
- 不改变现有测试通过、失败或 blocked 的判定语义。
