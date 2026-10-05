# 历史文档

当前活跃 ohosTest Runner 已迁至仓库根目录 `pyautorun/`。以下内容为旧 TypeScript 版本的历史说明，执行命令请参考根目录 README。

# HarmonyOS ohosTest Runner

独立的命令行工具，用于在配置好的设备矩阵上运行 HarmonyOS 工程中已有的 `ohosTest` 用例。工具负责构建 HAP、安装应用与测试包、执行 `aa test`、解析测试结果，并输出结构化报告和命令日志。

## 功能

- 执行 ohosTest 设备矩阵
- 按设备执行指定 suite class
- 在多 HAP 工程中按 phone、tablet、pc 部署映射分组执行
- 自动构建、安装、唤醒并校验设备解锁状态后执行测试
- `aa test` 卡死时由宿主机超时回收当前命令树，并继续下一台设备
- 输出 `result.json`、`summary.md`、`commands.log` 和设备日志
- 可选管理折叠屏/旋转控制服务

## 依赖

- Node.js 与 npm
- DevEco Studio 命令行工具
- HarmonyOS SDK 中的 `hdc`
- DevEco Emulator 命令
- Python 3.9+，用于设备执行步骤、测试结果解析及折叠屏控制服务；默认查找 `python3`（Windows 查找 `python`），可用 `AUTORUN_PYTHON` 指定解释器
- 可构建的 HarmonyOS 工程，且工程中已存在 `ohosTest` 用例

构建 HarmonyOS 工程需要设置：

```bash
export DEVECO_SDK_HOME="/Applications/DevEco-Studio.app/Contents/sdk"
export JAVA_HOME="/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home"
```

## 安装

依赖与白盒评价统一维护在仓库根目录。请在仓库根目录执行：

```bash
npm install
```

安装结束会自动构建 ohosTest 和白盒模块。

## 快速运行

```bash
npm run ohostest:matrix -- \
  --project /path/to/ResponsiveRepeatLayout \
  --machine-config /path/to/machine.json
```

以 SWE case 目录执行默认 answer 验证：

```bash
npm run ohostest:case -- \
  --case /path/to/ResponsiveRepeatLayout/case \
  --machine-config /path/to/machine.json
```

只在 phone 模拟器执行：

```bash
npm run ohostest:case -- \
  --case /path/to/ResponsiveRepeatLayout/case \
  --machine-config /path/to/machine.json \
  --device phone
```

默认会读取 `case/metadata.json`，在 `base_project + test_patch` 基础上继续应用 `golden_patch`，
只执行 `answer` 轮。需要完整 SWE/Answer 双轮比较时传入 `--run all`；只验证题目工程时传入
`--run swe`。设备连接、模拟器和工具路径来自 `--machine-config` 指定的配置文件；由 Autorun
调用时，该文件会根据 `config/autorun.config.json` 的 `ohosTest` 配置自动生成。实际设备集合优先使用 `metadata.device_test_suites`，其次使用
`metadata.enabled_devices`，两者都没有时使用 `machine.json.devices`。没有 `device_test_suites` 时每台设备执行
全量测试，不继承 `machine.json.devices[].testSuites`。默认报告输出到 `<case>/.ohostest-runs/<timestamp>/`。

`device_test_suites` 中的 `pc`、`2in1`（兼容大小写、连字符和下划线写法）当前会被自动跳过，
因为一多适配 Agent 尚不支持 PC 形态。混合设备用例仍执行其他设备；仅配置 PC 的用例直接生成
成功的零设备跳过结果，不执行补丁、构建或设备命令。该规则只作用于 `device_test_suites`，
不改变 matrix 模式或 `enabled_devices` 的 PC 执行能力。

多 HAP case 可通过 `metadata.device_hap_modules` 将 `phone`、`tablet`、`pc` 部署类型映射到
HAP 模块；`wide_fold` 和 `foldable` 自动使用 `phone` 映射，但仍分别执行自己的测试套件。

常用参数：

```text
--out <path>                  指定输出目录，目录下写入 result.json
--machine-config <path>       指定设备矩阵配置文件
--skip-build true|false       是否跳过构建
--keep-emulators true|false   运行结束后是否保留模拟器
```

case 模式额外支持：

```text
--case <path>                 指定 case 目录
--run answer|swe|all          运行范围，默认 answer
--device <id>                 只执行指定设备，可重复传入
--keep-workdir true|false     是否保留合成工程目录，默认 false
```

`--device` 必须属于 case 配置选择出的设备集合；可重复传入，例如 `--device phone --device tablet`。
SWE 和 Answer 两轮使用相同的筛选结果。case 模式仍不支持 `--test-class`，suite 选择只由 case 配置决定。

Runner 会把 `base_project` 复制到 `<case>/work` 后应用测试 patch 并构建，报告仍写入
`<case>/.ohostest-runs/<timestamp>`。这样不会修改 Agent 输出的 `base/task`，也避免报告时间戳
目录加深 Hvigor 的实际编译路径。默认执行结束后删除 `<case>/work`。

## 配置入口

集成运行时，设备矩阵统一维护在 Autorun 的 `config/autorun.config.json` 中。直接执行 Runner 命令时，使用 `--machine-config <path>` 指定同结构的独立配置文件。配置中需要提供 DevEco/HarmonyOS 工具路径、模拟器实例目录、设备 target、设备 profile、是否启动模拟器、每台设备要执行的 suite class，以及需要时的折叠屏控制配置。

## 文档索引

- [矩阵测试运行](docs/usage/matrix.md)
- [case 目录执行](docs/usage/case.md)
- [折叠屏和旋转控制](docs/usage/fold-control.md)
- [故障排查](docs/usage/troubleshooting.md)
- [工程结构说明](docs/project-structure/README.md)
