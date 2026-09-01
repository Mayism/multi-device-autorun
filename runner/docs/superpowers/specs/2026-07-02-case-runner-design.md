# case 目录执行模式设计

## 背景

`harmonyos-ohostest-runner` 当前只支持以单个 HarmonyOS 工程为输入：

```bash
npm run ohostest:matrix -- --project ../ResponsiveRepeatLayout/answer
npm run ohostest:matrix -- --project ../ResponsiveRepeatLayout/swe
```

现有矩阵执行链路会读取 `config/machine.json`，发现工程的 product、module、bundle、ohosTest module 和 HAP 产物路径，然后按设备构建、安装、执行 suite，并输出 `result.json`、`summary.md`、`commands.log` 和设备日志。

`ResponsiveRepeatLayout/case` 已经具备标准 case 交付结构：

```text
ResponsiveRepeatLayout/case/
  metadata.json
  test_patch.patch
  golden_patch.patch
```

其中 `metadata.json` 声明：

- `base_project`: 题目基线工程目录名。
- `test_patch`: 从基线工程生成测试工程的 patch。
- `golden_patch`: 从基线工程生成答案工程的 patch。
- `fail_to_pass` / `pass_to_pass`: SWE 风格的用例分类。
- `device_test_suites`: 每个设备应执行的 suite class 及对应测试文件。

新特性目标是让 runner 直接以 `case/` 为输入，自动合成并执行 SWE 结果和 Answer 结果，降低手动维护 `swe/`、`answer/` 双目录以及手动切换 suite 的成本。

## 目标

新增 case 目录执行模式，支持以下流程：

1. 读取 `ResponsiveRepeatLayout/case/metadata.json`。
2. 基于 `metadata.base_project` 定位基线工程。
3. 复制基线工程到一次性工作目录。
4. 在工作目录应用 `test_patch.patch`，执行一轮矩阵测试，作为 `swe` 结果。
5. 在同一个测试工程基础上继续应用 `golden_patch.patch`，执行第二轮矩阵测试，作为 `answer` 结果。
6. 设备、工具路径、模拟器启停、fold 控制等机器相关配置仍来自 `harmonyos-ohostest-runner/config/machine.json`。
7. 实际执行的设备集合和 suite class 使用工程 case 的 `metadata.json`，而不是 `machine.json` 中的 `devices[].testSuites`。
8. 执行完毕后输出一个包含 `swe` 和 `answer` 两轮报告的 case 级报告。

## 非目标

- 不替代现有 `--project` 矩阵执行模式。
- 不修改 `generate_harmony_case.py` 的输出格式。
- 不要求删除现有 `ResponsiveRepeatLayout/swe` 和 `ResponsiveRepeatLayout/answer` 目录。
- 不在 runner 内判断 fail-to-pass 是否“按预期失败”；第一阶段只采集两轮实际 ohosTest 结果，并在报告中保留分类信息供上层评分器判断。
- 不在工作区原地 `git apply` patch，避免污染用户当前工程。

## 输入结构

推荐命令：

```bash
npm run ohostest:case -- \
  --case ../ResponsiveRepeatLayout/case
```

可选参数沿用矩阵执行：

```text
--machine-config <path>       指定机器配置，默认 config/machine.json
--out <path>                  指定 case 级输出目录，目录下写入 result.json
--device <id>                 只运行指定设备，可重复传入
--skip-build true|false       是否跳过构建
--keep-emulators true|false   运行结束后是否保留模拟器
--keep-workdir true|false     是否保留合成工程目录，默认 false
```

不建议在 case 模式支持 `--test-class`。case 模式的 suite 选择应由 `metadata.device_test_suites` 控制；若允许 `--test-class` 覆盖，容易破坏 SWE/Answer 两轮报告的可比性。

## base_project 定位规则

`metadata.base_project` 是相对 `case/` 的兄弟目录或子目录名。解析优先级：

1. `<caseDir>/<metadata.base_project>`
2. `<caseDir>/../<metadata.base_project>`
3. 若以上不存在，报错 `case_base_project_not_found`

以当前 `ResponsiveRepeatLayout/case/metadata.json` 为例，`base_project` 为 `task`。如果仓库中只存在 `swe/`、`answer/`，但没有 `base/`，case 模式应明确失败并提示缺失基线工程；不应隐式拿 `swe/` 代替 `base/`，因为 patch 的基准语义不同。

## Patch 应用语义

两轮执行使用同一个临时工程逐步合成：

```text
base
  + test_patch.patch
    => swe run project
  + golden_patch.patch
    => answer run project
```

这符合用户要求中的“拼接 task + test_patch 执行一轮；再拼接上 golden_patch 执行一轮”。因此：

- `swe` 轮代表“题目工程 + 测试 patch”的结果。
- `answer` 轮代表“题目工程 + 测试 patch + 答案 patch”的结果。
- `golden_patch.patch` 应应用在已经包含测试代码的工作目录上。
- patch 应先执行 `git apply --check`，通过后再 `git apply`。
- 工作目录应初始化为普通目录即可；如使用 `git apply`，可在临时目录中 `git init`，但不得依赖源工程本身是 git 仓库。

如果 `golden_patch` 与 `test_patch` 修改同一文件并产生冲突，应将 `answer` 轮标记为 blocked，reason 为 `patch_apply_failed`，并保留 `swe` 轮结果。

## 配置合并规则

case 模式需要在进入现有 `runOhosTestMatrix()` 前生成“case 视角”的 matrix input。

### 来自 machine.json

继续使用：

- `paths`
- `product` / `module` / `bundleName` / `testModule` / `testRunner` / `timeoutMs` / `build` / `artifacts` 的显式覆盖
- `devices[].id`
- `devices[].profile`
- `devices[].target`
- `devices[].hdcPort`
- `devices[].startEmulator`
- `devices[].foldControl`

### 来自 metadata.json

覆盖：

- 参与执行的设备集合
- 每台设备的 suite class 列表

`metadata.device_test_suites` 示例：

```json
{
  "phone": [
    { "suite": "CommonPassToPassTest", "file": "products/entry/src/ohosTest/ets/test/CommonPassToPass.test.ets" },
    { "suite": "SmPassToPassTest", "file": "products/entry/src/ohosTest/ets/test/SmPassToPass.test.ets" }
  ]
}
```

合并规则：

1. 以 `metadata.device_test_suites` 的 key 作为 case 期望设备。
2. 每个 key 必须能在 `machine.json.devices[].id` 中找到同名设备。
3. 生成的 `DeviceConfig.testClasses` 使用 `metadata.device_test_suites[deviceId][].suite`，按 metadata 顺序去重。
4. 如果 CLI 传入 `--device`，先取 metadata 设备和 CLI 设备的交集；任何 CLI 设备不在 metadata 中都应报错。
5. `machine.json.devices[].testSuites` 在 case 模式中忽略，只作为普通 matrix 模式的默认值。

## 新增模块建议

```text
src/
  case/
    config.ts       # 读取和校验 metadata.json，生成设备 suite 覆盖
    patch.ts        # 复制 base、git apply --check/apply、清理工作目录
    runner.ts       # 编排 swe/answer 两轮 runOhosTestMatrix
    result.ts       # case 级状态和 summary 渲染
    types/
      index.ts
scripts/
  runOhosTestCase.ts
```

`src/index.ts` 新增导出：

```typescript
export { runOhosTestCase } from "./case/runner.js";
export { parseOhosTestCaseArgs } from "./cli/parseCaseArgs.js";
```

也可以先把 CLI 解析放进现有 `cli/parseArgs.ts`，但建议拆为 `parseMatrixArgs` 和 `parseCaseArgs`，避免 case 模式参数污染现有矩阵入口。

## API 设计

```typescript
interface RunCaseInput {
  caseDir: string;
  machineConfigPath?: string;
  out?: string;
  devices?: string[];
  skipBuild?: boolean;
  keepEmulators?: boolean;
  keepWorkdir?: boolean;
  commandExecutor?: CommandExecutor;
}

interface CaseMetadata {
  case_id: string;
  base_project: string;
  test_patch: string;
  golden_patch: string;
  fail_to_pass: string[];
  pass_to_pass: string[];
  device_test_suites: Record<string, CaseDeviceSuite[]>;
}

interface CaseDeviceSuite {
  suite: string;
  file?: string;
}
```

case runner 内部调用现有矩阵 runner：

```typescript
await runOhosTestMatrix({
  project: workProject,
  machineConfigPath,
  out: path.join(outDir, "swe", "result.json"),
  devices,
  skipBuild,
  keepEmulators,
  commandExecutor,
  deviceSuiteOverrides
});

await runOhosTestMatrix({
  project: workProject,
  machineConfigPath,
  out: path.join(outDir, "answer", "result.json"),
  devices,
  skipBuild,
  keepEmulators,
  commandExecutor,
  deviceSuiteOverrides
});
```

为了支持 suite 覆盖，`RunMatrixInput` 可新增可选字段：

```typescript
deviceSuiteOverrides?: Record<string, string[]>;
```

`loadMatrixConfig()` 在生成 `devices` 后应用该覆盖。该字段只影响内存中的标准化配置，不写回 `machine.json`。

## 输出报告

默认输出：

```text
<caseDir>/.ohostest-runs/<timestamp>/
  result.json
  summary.md
  work/
    project/                 # keepWorkdir=true 时保留
  swe/
    result.json
    summary.md
    commands.log
    device-*.log
  answer/
    result.json
    summary.md
    commands.log
    device-*.log
```

case 级 `result.json`：

```typescript
interface CaseResult {
  schemaVersion: "ohostest-case-v1";
  caseId: string;
  caseDir: string;
  baseProject: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "completed" | "failed";
  metadata: {
    failToPass: string[];
    passToPass: string[];
    deviceTestSuites: Record<string, CaseDeviceSuite[]>;
  };
  runs: {
    swe?: MatrixResult;
    answer?: MatrixResult;
  };
  artifacts: {
    summary: string;
    sweResult?: string;
    answerResult?: string;
    workdir?: string;
  };
  diagnostics: string[];
}
```

case 级状态建议：

- `completed`: 两轮都完成运行，且没有 patch/setup blocked。
- `failed`: 任一轮构建 blocked、设备 blocked、patch 失败或执行异常。

注意：矩阵层当前 `deriveMatrixStatus()` 只在设备 blocked 时返回 `failed`，suite failure 仍可返回 `completed`。case 模式应延续该语义，让报告能表达 “SWE 轮有测试失败但执行完成”。

`summary.md` 应至少包含：

- case id
- base project
- swe/answer 两轮状态
- 每轮各设备 suite/tests/failures/errors/passes/ignored
- `fail_to_pass` 和 `pass_to_pass` 列表
- patch/setup 诊断信息

## 错误处理

新增 blocked reason 建议：

```typescript
type CaseBlockedReason =
  | "case_metadata_missing"
  | "case_metadata_invalid"
  | "case_base_project_not_found"
  | "patch_file_missing"
  | "patch_apply_failed"
  | "metadata_device_missing_in_machine"
  | "metadata_device_has_no_suites";
```

错误策略：

- metadata 缺失或无效：不执行任何矩阵测试。
- base project 缺失：不执行任何矩阵测试。
- `test_patch` 应用失败：不执行 swe/answer，case failed。
- swe 矩阵执行失败：仍可继续尝试 answer，除非失败原因导致工作目录不可用。
- `golden_patch` 应用失败：保留 swe 报告，answer 缺失，case failed。
- cleanup 失败：不影响主状态，但写入 diagnostics。

## 测试计划

新增测试文件建议：

- `tests/case-config.test.ts`
  - 读取 `metadata.json`。
  - 校验必填字段。
  - 从 `device_test_suites` 生成 suite 覆盖。
  - metadata 设备不存在于 machine 时失败。

- `tests/case-patch.test.ts`
  - 复制 base 工程到临时目录。
  - `test_patch` 成功应用。
  - `golden_patch` 在 test patch 之后成功应用。
  - patch 冲突时返回 `patch_apply_failed`。

- `tests/case-runner.test.ts`
  - mock commandExecutor，验证 swe 和 answer 各调用一次 `runOhosTestMatrix` 所需命令链。
  - 验证 case 模式使用 metadata suite，而不是 machine suite。
  - 验证 `--device` 过滤只运行指定 metadata 设备。
  - 验证 swe 失败后仍生成 swe 报告，answer 可继续执行。

- `tests/cli.test.ts`
  - 解析 `--case`、`--machine-config`、`--out`、`--device`、`--keep-workdir`。
  - `--test-class` 在 case 模式中报错。

## 验收标准

1. 可以通过一条命令执行 `ResponsiveRepeatLayout/case`：

   ```bash
   npm run ohostest:case -- --case ../ResponsiveRepeatLayout/case
   ```

2. runner 使用 `config/machine.json` 中的设备连接、模拟器、fold 控制和工具路径。
3. runner 使用 `ResponsiveRepeatLayout/case/metadata.json` 中的 `device_test_suites` 决定设备和 suite。
4. 输出目录中包含 case 级 `result.json`/`summary.md`，以及 `swe/`、`answer/` 两轮矩阵报告。
5. `swe` 轮基于 `base + test_patch`。
6. `answer` 轮基于 `base + test_patch + golden_patch`。
7. 现有 `npm run ohostest:matrix` 行为保持兼容。
8. 新增和既有测试通过：

   ```bash
   npm test
   npm run build
   ```
