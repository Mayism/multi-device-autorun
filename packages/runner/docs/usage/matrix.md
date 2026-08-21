# 矩阵测试运行

运行器会在设备矩阵上执行 HarmonyOS 工程中已有的 `ohosTest` 用例。它不会生成测试用例、截图、dump 组件树，也不会判断布局规则本身。

## 命令

```bash
npm run ohostest:matrix -- \
  --project /path/to/ResponsiveRepeatLayout
```

常用参数：

```text
--out <path>                  指定 result.json 输出路径
--device <id>                 只运行指定设备，可重复传入
--machine-config <path>       指定设备矩阵配置文件
--test-class <className>      只运行指定 suite class
--skip-build true|false       是否跳过构建
--keep-emulators true|false   运行结束后是否保留模拟器
```

如果不传 `--device`，默认运行设备矩阵配置中的全部设备。命令行传入 `--test-class <className>` 时，只运行该 suite class。

## 工程信息发现

运行器会在目标 HarmonyOS 工程中自动读取：

- `build-profile.json5`：product 名称和模块列表
- 各模块的 `hvigorfile.ts`：通过 `hapTasks` 识别 HAP 模块
- `AppScope/app.json5`：bundle name
- `<hap-srcPath>/src/ohosTest/module.json5`：ohosTest module 名称

自动发现当前只支持适用于目标 product 的单 HAP 工程。找不到 HAP 或发现多个 HAP 时，
runner 会明确报错，不会再按模块名、目录名或模块顺序猜测。构建完成后，应用 HAP 和
测试 HAP 路径会根据该 HAP 模块的源码路径自动推导。

运行器也会读取 `build-profile.json5` 中适用于当前 product 的模块及其
`src/main/module.json5` 和 `oh-package.json5`。`module.type` 为 `shared` 的模块会在
构建后解析对应 HSP，按模块依赖顺序逐个安装；全部 HSP 成功后再安装应用 HAP和测试 HAP。

## 构建与安装

默认主构建按以下顺序执行：

```text
ohpm install
hvigorw clean --no-daemon
assembleApp
ohosTest@PackageHap
```

每次矩阵主构建先安装依赖，再 clean 一次。`--skip-build true` 会跳过依赖安装、clean 和全部构建命令，
但仍校验已有的 HAP/HSP 产物。折叠屏流程修改测试源码后单独重打 test HAP 时不会再次
clean，避免删除主构建生成的应用和 shared 模块产物。

设备安装不仅检查 HDC 退出码，也检查 AppMod 输出。若输出包含安装失败信息，即使 HDC
返回退出码 `0`，设备也会以 `install_failed` 阻断，不再执行 `aa test`。

## 设备矩阵配置

Autorun 会从 `config/autorun.config.json` 的 `ohosTest` 配置生成该文件。直接运行 Runner 时通过参数指定：

```text
--machine-config <path>
```

配置示例：

```json
{
  "paths": {
    "hvigorw": "/path/to/hvigorw",
    "ohpm": "/path/to/ohpm",
    "hdc": "/path/to/hdc",
    "emulatorBin": "/path/to/Emulator",
    "emulatorDeployedDir": "/path/to/.Huawei/Emulator/deployed",
    "foldServerScript": "src/fold/assets/fold-server.py"
  },
  "devices": [
    {
      "id": "phone",
      "profile": "Mate 80 Pro",
      "target": "127.0.0.1:15001",
      "hdcPort": 15001,
      "startEmulator": true,
      "testSuites": ["CommonPassToPassTest", "SmPassToPassTest"]
    },
    {
      "id": "foldable",
      "profile": "Mate X7",
      "target": "127.0.0.1:15002",
      "hdcPort": 15002,
      "startEmulator": true,
      "foldControl": true,
      "testSuites": [
        "CommonPassToPassTest",
        "MdFailToPassTest",
        "FoldControlTest"
      ]
    }
  ]
}
```

字段说明：

| 字段                        | 说明                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `paths.hvigorw`             | Hvigor 命令，可选；默认使用 PATH 中的 `hvigorw`                          |
| `paths.ohpm`                | ohpm 命令，可选；如果不配置，默认使用 `ohpm`                             |
| `paths.hdc`                 | hdc 命令，可选；默认使用 PATH 中的 `hdc`                                 |
| `paths.emulatorBin`         | DevEco 模拟器命令，必填；如果模拟器目录已加入环境变量，可填写 `Emulator` |
| `paths.emulatorDeployedDir` | 模拟器实例目录，必填                                                     |
| `paths.foldServerScript`    | fold-server.py 路径；有设备启用 `foldControl` 时必填                     |
| `devices[].id`              | 设备标识，用于 `--device`                                                |
| `devices[].profile`         | 模拟器 profile 名称                                                      |
| `devices[].target`          | hdc target，例如 `127.0.0.1:15002`                                       |
| `devices[].hdcPort`         | 启动模拟器时使用的 hdc 端口                                              |
| `devices[].startEmulator`   | 是否由运行器启动该模拟器                                                 |
| `devices[].foldControl`     | 是否启用折叠屏/旋转控制                                                  |
| `devices[].testSuites`      | 该设备要执行的 suite class 列表，按声明顺序运行，重复 class 会自动去重   |

设备 ID 只用于选择和报告，不用于判断设备形态。target 连接后，runner 会读取
`const.product.devicetype`：值为 `2in1` 时使用 PC 的 Enter 键解锁，其他值或读取失败时
继续使用触屏设备的 Home 键。发送按键后，runner 会通过 `ScreenlockService` 校验锁屏状态；
仍处于锁屏时最多重试 2 次并改用键码 `2054`。连续 3 次仍未解锁时，该设备记为
`blocked`（`device_unlock_failed`），完成清理后继续下一台设备。旧系统不支持锁屏状态探测时，
保留原有唤醒行为。无需为 PC 使用特定 `id`，也无需增加设备类型配置。

`aa test -w` 之外还有宿主机看门狗，超时时间为配置的 `timeoutMs + 30000ms`。如果设备端
超时未能让命令返回，Windows 上只强制结束本次 `aa test` 对应的进程树，不按进程名结束其他
`hdc`。当前设备记为 `timed_out`，清理模拟器和 fold-server 后继续执行下一台设备。

如果设备未配置 `testSuites`，且命令行未传 `--test-class`，运行器会执行完整测试模块。

## 输出结果

默认输出目录：

```text
<project>/.ohostest-runs/<timestamp>/
  result.json
  summary.md
  commands.jsonl
```

输出说明：

- `result.json`：完整矩阵结果，包含每台设备、每个 suite、每条用例的状态
- `summary.md`：人工可读汇总报告，包含设备汇总、suite 明细和用例明细
- `commands.jsonl`：构建、安装、启动模拟器、执行测试等结构化事件；可按
  `deviceId` 和 `suiteClass` 过滤设备及 suite 输出。每条用例对应一个
  `test_case` 事件，失败事件包含断言消息和堆栈

矩阵级 `status`：

- `completed`：所有选中的设备都完成了测试执行
- `failed`：至少有设备未完成执行，例如模拟器启动失败、hdc 未连接、解锁失败、安装失败、宿主机测试超时或测试输出无法解析

具体用例是否通过，请查看 `summary.md` 中每个 suite 下的用例状态，或查看 `result.json` 的 `devices[].suiteResults[].testCases`。
