# case 目录执行

case 模式以 `case/` 目录为输入，默认执行 answer 矩阵测试，也可以显式选择 swe 或完整双轮：

```text
base_project + test_patch    -> swe
base_project + test_patch + golden_patch -> answer
```

## 命令

```bash
npm run ohostest:case -- \
  --case /path/to/ResponsiveRepeatLayout/case
```

完整 SWE/Answer 双轮比较：

```bash
npm run ohostest:case -- \
  --case /path/to/ResponsiveRepeatLayout/case \
  --run all
```

只执行 phone，或同时执行 phone 和 tablet：

```bash
npm run ohostest:case -- \
  --case /path/to/ResponsiveRepeatLayout/case \
  --device phone

npm run ohostest:case -- \
  --case /path/to/ResponsiveRepeatLayout/case \
  --device phone \
  --device tablet
```

参数：

```text
--case <path>                 case 目录，必填
--run answer|swe|all          运行范围，默认 answer
--device <id>                 只执行指定设备，可重复传入
--machine-config <path>       设备矩阵配置文件
--out <path>                  指定 case 级输出目录，目录下写入 result.json
--skip-build true|false       是否跳过构建
--keep-emulators true|false   运行结束后是否保留模拟器
--keep-workdir true|false     是否保留合成工程目录，默认 false
```

`--device` 的 ID 必须属于 case 配置按 metadata 与设备矩阵配置选出的设备集合。指定非法 ID 时，
运行器会在执行设备矩阵前报错；未传入时仍执行 case 选择的全部设备。case 模式不接收
`--test-class`，suite 选择只来自 case 配置。

每个实际执行的矩阵轮次都会先执行 `ohpm install`，再执行一次 `hvigorw clean --no-daemon`。
因此 `--run all` 的 SWE 和 Answer 分别 clean，Answer 不会复用 SWE 的 Hvigor 构建缓存。
`--skip-build true` 时两轮都跳过依赖安装、clean 和构建，但仍校验已有 HAP/HSP 产物。

case 合成工程中适用于当前 product 的 shared 模块会被自动识别；其 HSP 会按模块依赖
顺序逐个安装，随后安装应用 HAP 和测试 HAP，不需要在 metadata 或 `machine.json`
中配置 HSP 路径。

## 输入目录

case 目录包含：

```text
case/
  metadata.json
  test_patch.patch
  golden_patch.patch
  <base_project>/
```

`metadata.json` 字段：

| 字段 | 说明 |
|------|------|
| `case_id` | case 标识 |
| `platform` | 可选。`native`（缺省，纯鸿蒙工程）、`web`（Web 用例）、`rn`（RNOH 工程，见下文「platform 平台」） |
| `rn_build` | 可选。仅 `platform: "rn"` 时有效；`bundle_commands` 覆盖默认 bundle 命令（见下文） |
| `base_project` | 基线工程目录名。运行器按 `<case>/<base_project>`、`<case>/../<base_project>` 顺序解析 |
| `test_patch` | 测试 patch 文件名 |
| `golden_patch` | 答案 patch 文件名 |
| `test_case_timeout_ms` | 可选。单个测试用例超时，单位毫秒，必须为正整数；默认 15000 |
| `pass_to_pass` | pass-to-pass 用例名列表 |
| `fail_to_pass` | fail-to-pass 用例名列表 |
| `device_test_suites` | 可选。设备到 suite class 的映射 |
| `enabled_devices` | 可选。没有 `device_test_suites` 时，声明要执行全量测试的设备 |
| `device_hap_modules` | 可选。多 HAP 工程中 phone、tablet、pc 部署类型到 HAP 模块名的映射 |

多 HAP 工程必须显式声明实际运行设备所需的部署类型。`wide_fold` 和 `foldable`
都会归一为 `phone`，但仍保留各自独立的设备和 suite：

```json
{
  "device_hap_modules": {
    "phone": "multisettingdefaultsample",
    "tablet": "multisettingdefaultsample",
    "pc": "multisettingpcsample"
  }
}
```

映射键只允许 `phone`、`tablet`、`pc`。目标必须是当前 product 中有效的 HAP 模块；
缺少运行设备需要的映射、指向非 HAP 模块或无法消除多 HAP 歧义时，运行器会在构建前报错。
未配置该字段的单 HAP 用例保持原有自动发现行为。

单个 case 可以覆盖 runner 的默认用例超时：

```json
{
  "test_case_timeout_ms": 30000
}
```

该值只覆盖 case 模式生成的 `aa test -s timeout` 参数；未配置时仍使用
`AA_TEST_CASE_TIMEOUT_MS` 的默认值 15000ms。它不会改变 `aa test -w` 的整体命令等待时间。

case 基线工程的模块发现规则与 matrix 模式一致：runner 通过模块 `hvigorfile.ts` 中的
`hapTasks` 识别 HAP 模块。当前自动发现要求适用于目标 product 的 HAP 模块恰好有一个。

`device_test_suites` 示例：

```json
{
  "phone": [
    {
      "suite": "CommonPassToPassTest",
      "file": "products/entry/src/ohosTest/ets/test/CommonPassToPass.test.ets"
    }
  ],
  "tablet": [
    {
      "suite": "LgFailToPassTest",
      "file": "products/entry/src/ohosTest/ets/test/LgFailToPass.test.ets"
    }
  ]
}
```

Case 模式会忽略 `device_test_suites` 中设备键为 `pc` 或 `2in1` 的测试套件（同时兼容大小写、
连字符和下划线写法），因为当前一多适配 Agent 不支持 PC 形态。其他设备仍按原顺序执行，
跳过项记录在结果的 `metadata.skippedDevices` 中，并在摘要里标记为 `skipped`。如果该字段仅包含
PC 套件，runner 会返回成功的零设备结果，且不会应用补丁、加载机器配置、构建或启动设备。
此规则不影响 matrix 模式，也不影响通过 `enabled_devices` 或机器配置显式执行 PC 测试。

`enabled_devices` 示例：

```json
["phone", "foldable"]
```

## platform 平台

`metadata.platform` 声明基线工程技术栈，缺省为 `native`（纯鸿蒙工程，行为不变）：

| 取值 | 说明 |
|------|------|
| `native` | 缺省。`base_project` 即鸿蒙工程根目录 |
| `web` | Web 用例。`base_project` 为 case 内相对路径，Case 需含 `web/` 目录；执行期间由 runner 拉起 dev 服务 |
| `rn` | RNOH（React Native for OpenHarmony）工程 |
| `flutter` | Flutter（flutter_flutter ohos 分支）工程，需配置 `paths.flutter`（见下文） |

### Web 用例

`platform: "web"` 的 Case 保留鸿蒙 `base_project` 和同级 `web/`。鸿蒙应用的
`Web.src` 统一使用 `http://127.0.0.1:5175`；`web/package.json` 必须提供 `dev` 脚本，
确保开发服务监听宿主机的 `127.0.0.1:5175` 或 `0.0.0.0:5175`。以 Vite 为例，
建议设置 `server.port: 5175` 和 `server.strictPort: true`，避免端口占用时自动换端口。

SWE、Answer 每轮应用补丁后分别判断工作副本的 lock 文件：

- 有 `package-lock.json` 或 `npm-shrinkwrap.json`：执行 `npm ci --no-audit --no-fund`。
- 无上述文件：执行 `npm install --no-audit --no-fund --package-lock=false`。

无 lock 时不生成新的 lock，避免 SWE 的安装产物改变 Answer 的安装策略。
已有 lock 不匹配或安装失败时会直接报告错误，不自动切换安装命令。安装不设 Runner
总耗时上限；每轮的实际命令写入 `commands.jsonl`，输出保存在 `web/<阶段>/install.log`。

Web 服务启动并通过宿主机 HTTP 检查后，Runner 等待每台设备 HDC 连接就绪，再执行
`hdc -t <target> rport tcp:5175 tcp:5175`，然后安装应用并执行该设备的测试套。
每台设备结束后清理本次创建的转发；即使保留模拟器或使用手动启动的设备也会清理。
已有相同映射会复用并保留，其他设备或其他端口的映射不会被删除；同一设备端口的
不同映射、端口占用或建立失败会阻止该设备执行并报告 `web_forward_failed`。
转发清理失败报告 `web_forward_cleanup_failed`，已收集的测试数据仍保留。

多设备各自使用设备内的 5175 端口，串行访问同一轮宿主机服务；此能力不依赖
`foldControl`，也不新增 `machine.json` 或 metadata 配置项。仅 Web Case 自动启用。
Runner 不会自动改写 Case 中原有的 `10.0.2.2` URL；旧用例需同步修改页面地址及相关
绝对资源地址。通过 IDE 单独运行应用时，需要另行建立 HDC 转发。

ArkWeb 默认让回环地址绕过代理，但显式覆盖该规则的应用仍需验证。宿主机 HTTP
就绪和 HDC 转发建立成功不等于页面业务加载已验证，页面内容仍由用例测试。

### Flutter 用例

`flutter` 布局约定：`base_project` 根目录为 Flutter 工程（`pubspec.yaml`、`lib/`），
鸿蒙宿主工程固定位于 `base_project/ohos/` 子目录（`hvigorfile.ts` 在 `ohos/` 下而非工程根）。
runner 复制基线工程后把 hvigor/ohpm 的执行目录自动指向 `ohos/`，模块发现、产物路径、
安装和 `aa test` 均与 native 模式一致；flutter 工具链从 `ohos/` 向上即可找到工程根的
`pubspec.yaml`。补丁仍打在 Flutter 工程根（`test_patch` 中的路径需带 `ohos/` 前缀）。

构建由 `flutter-hvigor-plugin` 完成：hvigor 构建时插件现场执行 `flutter assemble`
编译 Dart 并注入引擎 HAR 与 `flutter_assets`，因此构建命令序列与 native 完全一致，
不需要单独执行 `flutter build hap`。runner 复制基线工程后会做三项自愈（均不阻断，
失败由后续构建错误显式暴露）：

1. 生成 `ohos/local.properties` 的 `flutter.sdk=<paths.flutter>`（case 不携带本机绝对路径；case 自带该文件时保持原值）
2. `.dart_tool/package_config.json` 缺失时执行 `flutter pub get`（`.dart_tool` 被 .gitignore 排除，复制不带入）
3. `ohos/node_modules/flutter-hvigor-plugin` 缺失时建立指向 `<paths.flutter>/packages/flutter_tools/hvigor` 的目录链接（node_modules 被复制排除）

注意事项：

- `machine.json` 的 `paths.flutter` 必须指向 flutter_flutter ohos 分支 SDK 根目录
  （其 `bin/flutter`、`packages/flutter_tools/hvigor` 存在）；未配置时回退 case 自带
  `ohos/local.properties` 的 `flutter.sdk`。
- flutter 工程根的 `.gitignore` 排除的文件（`ohos/node_modules`、`.dart_tool`、
  `**/libs/**/libapp.so` 等）不会随基线工程复制，均由上述自愈和 hvigor 构建期生成补齐。
- hvigor 对构建路径长度有 259 字符上限，flutter 构建中间产物路径较深；case 路径较长时
  建议用 `--out` 把输出目录指到短路径（如 `--out E:\w\<case>`），否则构建报
  `00306001 The length of path exceeds the maximum length`。
- 产物为 unsigned HAP，直接 `hdc install -r` 安装到模拟器执行。

### RN 用例

`rn` 布局约定：`base_project` 根目录为 RN 侧（`package.json`、`metro.config.js`、RN 源码），
鸿蒙壳工程固定位于 `base_project/harmony/` 子目录。runner 会把 hvigor/ohpm 的执行目录
自动指向 `harmony/`，模块发现、产物路径、安装和 `aa test` 均与 native 模式一致。

SWE 和 Answer 每轮构建都会在 RN 根目录完整执行一遍 RN 前置命令（顺序固定）：

1. `npm install --force`（`--force` 规避 RN 依赖树的 ERESOLVE 冲突）
2. `ohpm install`（在 `harmony/`；部分 HAR 以 `file:` 协议引用 `node_modules` 内产物，必须在 npm 安装之后）
3. `npx react-native codegen-harmony --cpp-output-path ./harmony/<module>/src/main/cpp/generated --rnoh-module-path ./harmony/<module>/oh_modules/@rnoh/react-native-openharmony`（`--rnoh-module-path` 依赖 oh_modules，必须在 ohpm 安装之后）
4. `npx react-native bundle-harmony --dev`（产物写入 `harmony/<module>/src/main/resources/rawfile/`，随后打进 HAP）

第 4 步的 bundle 命令可用 `rn_build.bundle_commands` 覆盖，用于多 bundle 或自定义入口的工程
（codegen 路径由 RNOH 模板固定，无需也无法配置）：

```json
{
  "platform": "rn",
  "rn_build": {
    "bundle_commands": ["npm run dev:basic", "npm run dev:base"]
  }
}
```

- `bundle_commands` 为非空字符串数组，按顺序在 RN 根目录执行，替代默认的
  `npx react-native bundle-harmony --dev`；
- 仅 `platform: "rn"` 时允许配置；标准单 bundle 模板工程无需配置。

应用 HAP 使用 `hvigorw --mode module -p product=<product> assembleHap --no-daemon`（模块模式，默认 debug）。
RNOH 0.72 在 release 模式（项目级 `assembleApp` 的默认，含混淆与裁剪）下会破坏 NAPI 按名解析，
导致应用启动即崩（jscrash：`NapiBridge postMessageToCpp undefined is not callable`），
因此 rn 平台不使用 `assembleApp`。

每轮重建是 SWE-bench 语义的要求：`golden_patch` 可能修改 RN 源码或 `package.json`，
answer 轮必须重新生成 bundle 才能让 golden 的 RN 改动生效。

注意事项：

- `node`/`npm` 必须可用（PATH 或 `machine.json` 的 `paths.npm`）；`npx` 随 Node 提供。
- codegen 的 ArkTS 产物与 `oh_modules/@rnoh/react-native-openharmony/ts.ts` 的
  `export * from './generated/ts'` 注入由工程自身的 hvigor 脚本负责，runner 不做修改。
- 产物为 unsigned HAP，直接 `hdc install -r` 安装到模拟器执行。
- `hvigorw clean` 会对各 abi 目录执行 `ninja clean` 并删除 `CMakeCache.txt`，强制下次
  构建重新 CMake configure，codegen 重新生成的 C++ 不会被 `.cxx` 陈旧缓存卡住；无需手动清理 `.cxx`。

## 配置来源

case 模式使用设备矩阵文件中的机器相关配置：

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
      "bootMode": "coldboot",
      "startEmulator": true
    },
    {
      "id": "foldable",
      "profile": "Mate X7",
      "target": "127.0.0.1:15002",
      "hdcPort": 15002,
      "startEmulator": true,
      "foldControl": true
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `paths.hvigorw` | Hvigor 命令，必填；如果命令目录已加入环境变量，可填写 `hvigorw` |
| `paths.ohpm` | ohpm 命令，可选；如果不配置，默认使用 `ohpm` |
| `paths.npm` | npm 命令，可选；`platform: "rn"` 时用于 `npm install --force`，不配置默认用 PATH 上的 `npm` |
| `paths.flutter` | flutter_flutter ohos 分支 SDK 根目录，可选；`platform: "flutter"` 时必配（用于 pub get、hvigor 插件链接与 `local.properties` 生成），不配置回退 case 自带 `ohos/local.properties` 的 `flutter.sdk` |
| `paths.hdc` | hdc 命令，必填；如果命令目录已加入环境变量，可填写 `hdc` |
| `paths.emulatorBin` | DevEco 模拟器命令，必填；如果模拟器目录已加入环境变量，可填写 `Emulator` |
| `paths.emulatorDeployedDir` | 模拟器实例目录，必填 |
| `paths.foldServerScript` | fold-server.py 路径；有设备启用 `foldControl` 时必填 |
| `devices[].id` | 设备标识，用于 `--device` |
| `devices[].profile` | 模拟器 profile 名称 |
| `devices[].target` | hdc target，例如 `127.0.0.1:15002` |
| `devices[].hdcPort` | 启动模拟器时使用的 hdc 端口 |
| `devices[].bootMode` | 模拟器启动模式，默认 `coldboot`；可选 `reset` 或 `snapshot` |
| `devices[].startEmulator` | 是否由运行器启动该模拟器 |
| `devices[].foldControl` | 是否启用折叠屏/旋转控制 |


case 模式按以下优先级决定设备与 suite：

1. 有 `metadata.device_test_suites` 时，按该字段选择设备和 suite class。
2. 无 `device_test_suites`、有 `metadata.enabled_devices` 时，按 enabled 设备执行全量测试。
3. 两者都没有时，按设备矩阵配置中的全部设备执行全量测试。

传入一个或多个 `--device` 后，运行器按 CLI 顺序从上述结果中筛选设备并去重；SWE 和 Answer
两轮复用同一筛选结果。

设备矩阵配置中的 `devices[].testSuites` 不参与 case 模式的全量测试选择。

## 执行流程

1. 读取 `metadata.json`。
2. 复制 `base_project` 到 case 目录下的浅层工作工程 `work/`。
3. 在 `work/` 应用 `test_patch`。
4. 读取 case 设备选择结果。
5. `--run swe` 或 `--run all` 时调用矩阵运行，输出到 `swe/result.json`。
6. `--run answer` 或 `--run all` 时在同一个 `work/` 继续应用 `golden_patch`，再调用矩阵运行，输出到 `answer/result.json`。
7. 写入 case 级 `result.json` 和 `summary.md`。未执行的一侧在 summary 中显示为 `not run`。
8. `--keep-workdir` 为 `false` 时删除 case 目录下的 `work/`。

`platform: "rn"` 时，第 5、6 步每轮构建前会先在 RN 根目录执行 npm 安装、codegen 和
bundle 构建（见「platform 平台」），再进入原有的 hvigor 构建、安装与测试流程。

配置 `device_hap_modules` 后，每轮先按 HAP 模块分组，再分别构建、安装和执行。
例如上述映射会将 phone、wide_fold、foldable、tablet 放入默认 HAP 组，将 pc 放入 PC HAP 组。

### deviceTypes 兼容执行与检查

case runner 会根据每个执行组最终选中的设备计算 HAP 所需的 `module.deviceTypes`：

| 设备 ID | module.deviceTypes |
| --- | --- |
| `phone`、`wide_fold`、`foldable` | `phone` |
| `tablet` | `tablet` |
| `pc`、`2in1` | `2in1` |
| `tv`、`wearable`、`car` | 同名类型 |

自定义设备 ID 无法可靠推断类型，runner 会在构建前报告 `case_device_type_unmapped`。

SWE 和 Answer 每个 HAP 执行组构建前，runner 都会保存目标 HAP 以及当前 product 下 HSP
的原始 `src/main/module.json5`，临时补充缺失类型，并在构建、安装和测试结束或异常后逐字恢复。
该兼容层不会修改 `src/ohosTest/module.json5`。

SWE 缺少设备类型视为基线状态，不额外计为失败。Answer 会根据临时补充前的 HAP 原始声明，
为每台设备追加 `ModuleDeviceTypeCompatibility` 检查：声明正确时通过；缺失时即使后续 UT
已经执行，也会产生 `should_declare_<deviceType>_device_type` 失败。临时兼容只保证测试可执行，
不会掩盖答案漏改 `deviceTypes` 的问题。

`CaseResult.status` 仍表示执行链是否完成。Answer 的声明错误通过设备的 `failed` 状态、测试
失败计数和 case summary 中的 `runner_check`/`incorrect` 表达。

## 输出结果

默认输出目录（`<timestamp>` 为 `yyyymmddhhmmss` 本地时间，如 `20260911014420`）：

```text
<case>/.ohostest-runs/<timestamp>/
  result.json          # case 级 JSON 报告，包含 metadata、runs.swe/runs.answer、artifacts、diagnostics
  summary.md           # case 级 Markdown 汇总，包含 Runs、Module Runs、设备结果与测试分类
  commands.jsonl       # case、swe 和 answer 共用的结构化命令日志
  swe/                 # 仅在执行 --run swe 或 --run all 时生成
    result.json        # swe 矩阵 JSON 报告，包含构建结果、设备结果、suite 结果、test case 明细
    summary.md         # swe 矩阵 Markdown 汇总，按设备和 suite 展示矩阵执行结果
    screenshots/       # 失败用例的设备截图，按设备 ID 分目录（见下文）
  answer/              # 仅在执行 --run answer 或 --run all 时生成
    result.json        # answer 矩阵 JSON 报告，包含构建结果、设备结果、suite 结果、test case 明细
    summary.md         # answer 矩阵 Markdown 汇总，按设备和 suite 展示矩阵执行结果
    screenshots/       # 失败用例的设备截图，按设备 ID 分目录（见下文）
```

合成工程不放在报告时间戳目录内，而是放在 `<case>/work/`。这样报告路径可以保持完整，
Hvigor 实际编译路径仍与 `<case>/base` 或 `<case>/task` 基本等长。`work/` 内容为
`base_project + test_patch`，answer/all 模式下还会继续应用 `golden_patch`。

多 HAP 轮次会在 `swe/modules/<module>/` 或 `answer/modules/<module>/` 中写入各模块的
`result.json` 和 `summary.md`。顶层矩阵结果保持现有格式，并可选增加 `module_runs`，记录
每个模块对应的设备、构建产物、结果路径和诊断。单 HAP 用例不生成该字段。

### 设备屏幕截图

只为失败用例保留截图，`aa test` 执行期间每 1 秒滚动抓取一帧设备屏幕；用例上报失败时，
仅保留拍摄于该用例执行期间的帧，否则对失败现场尽力补拍。通过、忽略的用例与无失败的
运行不产生截图；命令在用例上报前结束时，遗留帧可作为最后一条用例的卡死现场保留。

截图保存在对应轮次的 `screenshots/<deviceId>/` 下，设备结果的 `screenshots` 字段和轮次
`summary.md` 的设备小节会列出相对路径。用例名中的特殊字符替换为 `_`，解锁重试第二轮
追加 `-2` 后缀。截图失败只跳过该帧，不影响测试结果判定；自定义 `commandExecutor`
使用缓冲执行时，行事件会在命令结束后投递。

`swe/result.json` 和 `answer/result.json` 的命令日志路径均指向顶层
`commands.jsonl`。可按 `phase`、`deviceId` 和 `suiteClass` 过滤对应事件；
失败的 `test_case` 事件包含断言消息和堆栈。

`--keep-workdir false` 时，运行结束后删除 `<case>/work/`。

case 级 `summary.md` 包含：

- `Runs`：swe 和 answer 两侧总体统计，未执行的一侧显示 `not run`
- `Module Runs`：多 HAP 用例中各模块对应的设备和执行状态
- `Device Results`：每台设备按 test case 列出执行结果，并通过 `Suite` 列辅助定位
- `Totals`：按设备和运行侧汇总整体判定；`--run all` 时每台设备分别输出 swe 和 answer
- `Device Suites`：metadata 中的设备 suite 列表
- `Pass To Pass`：metadata 中的 pass-to-pass 用例名
- `Fail To Pass`：metadata 中的 fail-to-pass 用例名
- `Diagnostics`：存在诊断信息时输出

`Device Results` 的表格结构：

单独运行 `--run swe`：

```markdown
### foldable

#### SWE Results

| Suite | Test Case | Category | SWE Actual | Expected | Verdict |
| --- | --- | --- | --- | --- | --- |
| CommonPassToPassTest | should_start_ability_successfully | pass_to_pass | passed | SWE pass | correct |
| MdAdaptiveTest | should_use_two_columns_on_foldable | fail_to_pass | failed | SWE fail | correct |
| MdAdaptiveTest | should_keep_card_width_adaptive | fail_to_pass | passed | SWE fail | incorrect |
| MdAdaptiveTest | should_have_metadata_entry | unclassified | passed | metadata category required | incorrect |
```

单独运行 `--run answer`：

```markdown
### foldable

#### Answer Results

| Suite | Test Case | Category | Answer Actual | Expected | Verdict |
| --- | --- | --- | --- | --- | --- |
| CommonPassToPassTest | should_start_ability_successfully | pass_to_pass | passed | Answer pass | correct |
| MdAdaptiveTest | should_use_two_columns_on_foldable | fail_to_pass | passed | Answer pass | correct |
| MdAdaptiveTest | should_keep_card_width_adaptive | fail_to_pass | failed | Answer pass | incorrect |
```

运行 `--run all`：

```markdown
### foldable

#### Comparison Results

| Suite | Test Case | Category | SWE Actual | Answer Actual | Expected | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| CommonPassToPassTest | should_start_ability_successfully | pass_to_pass | passed | passed | SWE pass, Answer pass | correct |
| MdAdaptiveTest | should_use_two_columns_on_foldable | fail_to_pass | failed | passed | SWE fail, Answer pass | correct |
| MdAdaptiveTest | should_keep_card_width_adaptive | fail_to_pass | passed | passed | SWE fail, Answer pass | incorrect |
```

test case 分类只来自 `metadata.json`：

- `metadata.pass_to_pass` 中的 test case 归为 `pass_to_pass`。
- `metadata.fail_to_pass` 中的 test case 归为 `fail_to_pass`。
- 同时出现在两边时归为 `conflict`，固定判为 `incorrect`。
- 未出现在任一数组中时归为 `unclassified`，固定判为 `incorrect`。

runner 生成的 `ModuleDeviceTypeCompatibility` 用例归为 `runner_check`，只要求 Answer 通过；
它不参与 SWE 侧统计，也不要求写入 `pass_to_pass` 或 `fail_to_pass`。

当 suite 没有解析到 test case 明细时，输出 `none parsed` 行，并用 suite 级状态作为 actual，但分类为 `unclassified`。

`Totals` 的表格结构：

```markdown
## Totals

| Device | Run | Tests | Correct | Incorrect | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| foldable | swe | 13 | 13 | 0 | correct |
| foldable | answer | 13 | 13 | 0 | correct |
| tablet | swe | 11 | 11 | 0 | correct |
| tablet | answer | 11 | 11 | 0 | correct |
```

## 状态

case 级 `status`：

- `completed`：所选运行范围内至少有一轮矩阵运行完成，且没有 case 级诊断信息
- `failed`：所选运行范围内没有任何矩阵结果、任一已执行矩阵状态为 failed，或存在 case 级诊断信息

矩阵级 `status` 的含义与矩阵模式一致。suite failure 不会使矩阵级 `status` 变为 failed；设备 blocked 会使矩阵级 `status` 变为 failed。
