# 故障排查

矩阵返回 `failed` 时，按 build 阶段和设备阶段定位。

## 构建阶段：Invalid DEVECO_SDK_HOME

现象：`build_failed`，hvigor 报 `Invalid DEVECO_SDK_HOME` 或 `SDK component missing`。

根因：`DEVECO_SDK_HOME` 未设置，或路径层级写错。

`DEVECO_SDK_HOME` 必须指向 `.../sdk`：

```bash
export DEVECO_SDK_HOME="/Applications/DevEco-Studio.app/Contents/sdk"
```

## 构建阶段：Unable to locate Java Runtime

现象：hvigor 报 `Unable to locate Java Runtime` 或 `Could not find tools.jar`。

根因：hvigor 工具链依赖 JDK，还缺 `JAVA_HOME`。DevEco Studio 自带 JBR，可直接指向它：

```bash
export JAVA_HOME="/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home"
```

如果 hvigor daemon 已在旧环境下启动，终止 daemon 后再运行。

## 设备阶段：hdc_not_connected 或设备 profile 不存在

现象：`build` 通过但设备阶段报 `hdc_not_connected`，或启动模拟器失败。

检查点：

1. `emulatorDeployedDir` 路径里的用户名必须与当前系统真实用户一致。
2. `profile` 必须与 `~/.Huawei/Emulator/deployed/` 下的目录名完全一致。
3. `target` 必须与 `hdc list targets` 输出一致。

排查命令：

```bash
ls ~/.Huawei/Emulator/deployed/
hdc list targets
```

## 设备阶段：唤醒后仍停留在锁屏

runner 通过目标系统参数判断 PC：

```bash
hdc -t <target> shell param get const.product.devicetype
```

MateBook/2in1 目标应返回 `2in1`，runner 随后发送 Enter 键码 `2054`。如果参数读取失败或
返回其他值，runner 会兼容性回退到 Home。发送按键后，runner 使用以下命令检查真实锁屏状态：

```bash
hdc -t <target> shell hidumper -s ScreenlockService -a -all
```

如果输出仍为 `screenLocked true`，runner 会等待系统稳定并使用键码 `2054` 重试，最多共
3 次。始终未解锁时设备结果为 `blocked`，原因为 `device_unlock_failed`，清理后继续下一台设备。
检查 `commands.jsonl` 中对应 `deviceId` 的事件，确认探测结果及实际发送的按键；设备 `id`
不参与类型判断。系统不支持 `ScreenlockService` 时不会仅因无法探测而阻断。

## 设备阶段：aa test 超时后命令仍不返回

现象：设备端 `aa test -w` 已到期，但宿主机 `hdc` 命令仍不退出，导致下一台设备无法开始。

处理：runner 为 `aa test` 设置了 `timeoutMs + 30 秒`的宿主机强制超时。超时后 Windows
使用当前命令 PID 执行 `taskkill /T /F`，仅结束本次命令树；当前设备状态记为 `timed_out`，
随后执行该设备的模拟器和 fold-server 清理，并继续下一台设备。可在 `commands.jsonl` 中搜索
`TEST_COMMAND_TIMED_OUT` 定位。

## 折叠测试失败：折叠命令被设备拒绝

现象：`FoldControlTest` 出现 `cannot connect` 或折叠/展开用例失败，但旋转用例能过。

原因：启用 `foldControl: true` 并执行折叠命令的设备需要是可折叠设备或折叠屏模拟器。直板机可执行旋转命令，但不能执行折叠命令。

处理方式：将折叠测试运行在折叠屏实例上，并确认 `profile` 和 `target` 正确。

## 折叠或旋转命令失败：Emulator Unknown options

现象：fold-server 输出以下错误之一：

```text
Emulator: Unknown options: instance, rotation
Emulator: Unknown options: instance, foldedstate
```

原因：当前 DevEco Emulator 版本不支持折叠/旋转控制所需的命令参数。

检查版本：

```bash
Emulator -version
```

处理方式：使用 `26.0.0.200` 或以上版本的 Emulator。

## RNOH（platform: "rn"）构建问题

RN 前置命令的顺序是硬约束，颠倒会直接失败：

- `ohpm install` 必须在 `npm install` 之后——壳工程 `oh-package.json5` 常以
  `file:` 协议引用 `node_modules` 内的 HAR。
- `codegen-harmony` 必须在 `ohpm install` 之后——`--rnoh-module-path` 指向
  `oh_modules/@rnoh/react-native-openharmony`，包不存在时 codegen 无处生成 ArkTS 产物。

常见报错与处理：

| 现象 | 处理 |
|------|------|
| `npm install` 报 ERESOLVE | runner 已使用 `npm install --force`；若仍失败，检查 Node 版本（RNOH 通常要求 ≥16） |
| 安装启动即崩（App died） | `oh_modules/@rnoh/react-native-openharmony/ts.ts` 缺少 `export * from './generated/ts';`，该注入由工程 hvigor 脚本负责，确认脚本已生效 |
| codegen 报找不到命令 | `react-native` CLI 子命令由 `@react-native-oh/react-native-harmony-cli` 注册，确认 devDependencies 已安装（`npm install --force` 已执行） |
| 改了 C++/codegen 产物但行为不变 | `hvigorw clean` 已删除 `CMakeCache.txt` 强制重新 configure；仍异常时可手动删除 `harmony/<module>/.cxx` 后重跑 |

RN bundle（`bundle.harmony.js` 与 assets）由 `bundle-harmony` 写入
`harmony/<module>/src/main/resources/rawfile/`，位于 `src/main` 下，`hvigorw clean`
不会清除；产物为 unsigned HAP，直接安装到模拟器执行。

## 环境变量生效范围

runner 通过子进程调用 hvigor，子进程继承 runner 启动时 shell 的环境变量。hvigor daemon 如果已经运行，会继续使用启动时的环境变量。

设置 `DEVECO_SDK_HOME` 和 `JAVA_HOME` 后，终止旧 hvigor daemon，再重新运行矩阵测试。
