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

`enabled_devices` 示例：

```json
["phone", "foldable"]
```

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
| `paths.hvigorw` | Hvigor 命令，可选；默认使用 PATH 中的 `hvigorw` |
| `paths.ohpm` | ohpm 命令，可选；如果不配置，默认使用 `ohpm` |
| `paths.hdc` | hdc 命令，可选；默认使用 PATH 中的 `hdc` |
| `paths.emulatorBin` | DevEco 模拟器命令，必填；如果模拟器目录已加入环境变量，可填写 `Emulator` |
| `paths.emulatorDeployedDir` | 模拟器实例目录，必填 |
| `paths.foldServerScript` | fold-server.py 路径；有设备启用 `foldControl` 时必填 |
| `devices[].id` | 设备标识，用于 `--device` |
| `devices[].profile` | 模拟器 profile 名称 |
| `devices[].target` | hdc target，例如 `127.0.0.1:15002` |
| `devices[].hdcPort` | 启动模拟器时使用的 hdc 端口 |
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

配置 `device_hap_modules` 后，每轮先按 HAP 模块分组，再分别构建、安装和执行。
例如上述映射会将 phone、wide_fold、foldable、tablet 放入默认 HAP 组，将 pc 放入 PC HAP 组。

## 输出结果

默认输出目录：

```text
<case>/.ohostest-runs/<timestamp>/
  result.json          # case 级 JSON 报告，包含 metadata、runs.swe/runs.answer、artifacts、diagnostics
  summary.md           # case 级 Markdown 汇总，包含 Runs、Module Runs、设备结果与测试分类
  commands.jsonl       # case、swe 和 answer 共用的结构化命令日志
  swe/                 # 仅在执行 --run swe 或 --run all 时生成
    result.json        # swe 矩阵 JSON 报告，包含构建结果、设备结果、suite 结果、test case 明细
    summary.md         # swe 矩阵 Markdown 汇总，按设备和 suite 展示矩阵执行结果
  answer/              # 仅在执行 --run answer 或 --run all 时生成
    result.json        # answer 矩阵 JSON 报告，包含构建结果、设备结果、suite 结果、test case 明细
    summary.md         # answer 矩阵 Markdown 汇总，按设备和 suite 展示矩阵执行结果
```

合成工程不放在报告时间戳目录内，而是放在 `<case>/work/`。这样报告路径可以保持完整，
Hvigor 实际编译路径仍与 `<case>/base` 或 `<case>/task` 基本等长。`work/` 内容为
`base_project + test_patch`，answer/all 模式下还会继续应用 `golden_patch`。

多 HAP 轮次会在 `swe/modules/<module>/` 或 `answer/modules/<module>/` 中写入各模块的
`result.json` 和 `summary.md`。顶层矩阵结果保持现有格式，并可选增加 `module_runs`，记录
每个模块对应的设备、构建产物、结果路径和诊断。单 HAP 用例不生成该字段。

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
