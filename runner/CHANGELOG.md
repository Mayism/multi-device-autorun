# 更新日志

本项目的所有重要变更都会记录在此文件中。

本文档格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循[语义化版本](https://semver.org/spec/v2.0.0.html)。

## [0.1.10] - 2026-08-14

### 修复

- case 模式执行包含 tablet 的 SWE 工程时，除目标 HAP 外也为当前 product 下的 HSP 模块临时补充 `tablet` 设备类型，并在执行完成或异常后恢复原始配置。

## [0.1.9] - 2026-08-12

### 修复

- 由 runner 统一管理 fold-server 进程、宿主机端口和 HDC 反向转发，支持重复执行、SWE→Answer、多设备串行及异常中断后的 target 级残留恢复。
- 使用 owner token 校验 fold-server 身份；端口被外部服务占用时不误杀，并通过 `fold_cleanup_failed` 保留已有测试统计后阻断设备。
- fold-server 增加 `self`/`external` 转发模式，HDC 和 Emulator 改用参数数组执行，修复 Windows 空格路径、target 丢失和负 PID 终止问题。

## [0.1.8] - 2026-08-11

### 新增

- case 模式支持通过 `device_hap_modules` 为 phone、tablet 和 pc 配置部署 HAP，并将 wide_fold、foldable 归一到 phone 后按 HAP 模块分组构建、安装和执行。
- 多 HAP 执行结果支持输出可选的 `module_runs`，记录每个模块对应的设备、构建产物与诊断信息。
- 增加部署类型映射、HAP 模块有效性、折叠设备归一、模块分组、产物匹配和结果聚合测试，同时保持未配置映射的单 HAP 用例兼容。

### 修复

- 设备处于锁屏状态导致测试启动失败时，唤醒设备并自动重试一次。
- TestAbility 启动或销毁过程出现瞬时异常时自动重试，降低设备切换期间的偶发失败。

## [0.1.7] - 2026-08-04

### 变更

- 主构建调整为先执行 `ohpm install`，再执行 `hvigorw clean --no-daemon`，确保 clean 加载构建配置时依赖已经就绪。
- case 模式复制基线工程时遵循工程根目录及各级子目录的 `.gitignore` 规则，避免将依赖、构建产物和本地缓存复制到工作目录。

## [0.1.6] - 2026-07-30

### 新增

- 使用 Pino 10 输出结构化 JSONL 日志，case 和 matrix 每次运行只生成一个顶层 `commands.jsonl`。
- 命令事件支持 `phase`、`deviceId` 和 `suiteClass` 上下文；测试执行生成独立的 `test_case` 与 `test_suite` 事件。
- 失败用例在日志和 `result.json` 中保存断言消息、堆栈及执行耗时。

### 变更

- case、阶段、matrix 和设备结果统一指向顶层命令日志，不再生成阶段级或设备级日志文件。
- 成功解析 `aa test` 输出后不再将完整 OHOS 状态协议写入命令 `stdout`，改为逐用例结构化记录；解析失败时仍保留原始输出。

### 修复

- 配置文件读取、解析和校验错误现在包含稳定错误分类与具体文件路径，并同步写入日志、结果文件和 CLI 错误输出。
- 设备连接和断开轮询只记录终止轮询的最后一次命令结果，避免重复日志干扰排障。

## [0.1.5] - 2026-07-28

### 修复

- 设备连接后通过 `const.product.devicetype` 自动识别 HarmonyOS PC/2in1，并使用 Enter 键码 `2054` 解锁；其他设备及探测失败场景继续使用 Home 键，不依赖用户自定义设备 ID。

## [0.1.4] - 2026-07-28

### 新增

- case 模式支持读取 `metadata.json` 的 `test_case_timeout_ms`，按用例覆盖 `AA_TEST_CASE_TIMEOUT_MS`，并将生效值传递给 `aa test -s timeout`。

### 修复

- 根据模块 `hvigorfile.ts` 是否使用 `hapTasks` 自动发现 HAP 模块，不再依赖 `entry` 模块名或目录名；当前仅支持单 HAP 工程，并为未找到或发现多个 HAP 提供明确错误。

## [0.1.3] - 2026-07-27

### 修复

- 主构建开始时先执行一次 `hvigorw clean --no-daemon`，避免上一轮 Hvigor 缓存影响当前矩阵结果。
- 自动发现当前 product 下的 shared 模块 HSP，按模块依赖顺序逐个安装后再安装应用和测试 HAP，支持 HAP 依赖 HSP 的工程。
- 检查 HDC AppMod 输出中的安装错误；即使进程退出码为 `0`，安装失败也会阻断设备且不再执行测试。

## [0.1.2] - 2026-07-16

### 新增

- case 模式支持可重复的 `--device <id>` 参数，可只执行 case 配置允许的指定设备，例如 `phone` 或 `tablet`。
- 指定不属于 case 设备集合的 ID 时，在执行设备矩阵前返回明确错误。

### 修复

- case 模式在平板执行 SWE 时，临时为入口模块的 `module.deviceTypes` 增加 `tablet`，避免应用进入兼容模式而影响 UI 测试准确性。
- SWE 执行结束或异常后恢复原始 `module.json5`，确保 Answer 和 golden patch 不受临时配置影响。

## [0.1.1] - 2026-07-16

### 修复

- 安装应用和测试 HAP 前，先卸载配置中指定的应用包，避免在同一设备上重复安装相同包名应用时出现 HDC 错误 `9568267`（`install entry already exist`）。
- 忽略安装前卸载失败，确保设备上尚未安装对应应用时仍能继续执行首次安装。
- 支持解析 JSON5 文件中的单引号键和值。
