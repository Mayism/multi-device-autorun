# case 模式设备选择降级规则设计

## 背景

现有 case 模式设计要求 `metadata.json` 必须提供 `device_test_suites`，并用它同时决定：

- 参与执行的设备集合。
- 每台设备执行的 suite class。

这适合精确指定 suite 的 case，但不适合只想声明“哪些设备要跑全量测试”的 case。新增一个轻量字段 `enabled_devices`，用于在没有 `device_test_suites` 时选择设备。

## 目标

case 模式按以下优先级决定设备和 suite：

1. `metadata.device_test_suites` 存在时，保持现有行为：按该字段选择设备，并按每台设备声明的 suite class 执行。
2. `metadata.device_test_suites` 不存在、但 `metadata.enabled_devices` 存在时，按 `enabled_devices` 选择设备，每个设备执行全量测试。
3. 两个字段都不存在时，按 `machine.json.devices` 中配置的设备执行，每个设备执行全量测试。

这里的“全量测试”指不向 ohosTest 传入 suite class 过滤条件，让测试 runner 执行 test module 下发现的全部测试。case 模式在这两种全量场景下不使用 `machine.json.devices[].testSuites`。

## metadata.json 新字段

```json
{
  "enabled_devices": ["phone", "foldable"]
}
```

规则：

- `enabled_devices` 是可选字段。
- 值必须是非空字符串数组。
- 每个值表示一个 `machine.json.devices[].id`。
- 字段存在时数组不能为空。
- 重复设备按首次出现顺序去重。
- 每个设备都必须存在于 `machine.json.devices`，否则报错 `metadata_device_missing_in_machine`。

## 配置合并规则

生成 case 视角的 matrix input 时：

| metadata 状态 | 设备来源 | suite 来源 |
| --- | --- | --- |
| 有 `device_test_suites` | `Object.keys(device_test_suites)` | `device_test_suites[device].suite` |
| 无 `device_test_suites`，有 `enabled_devices` | `enabled_devices` | 全量测试 |
| 两者都无 | `machine.json.devices` | 全量测试 |

case 模式不支持 CLI `--device` 参数。设备选择必须只来自 `metadata.device_test_suites`、`metadata.enabled_devices` 或 `machine.json.devices`，避免 SWE/Answer 两轮报告被运行时参数改写。

## API 调整

`CaseMetadata` 新增可选字段：

```typescript
interface CaseMetadata {
  deviceTestSuites?: Record<string, CaseDeviceSuite[]>;
  enabledDevices?: string[];
}
```

case 配置层新增一个归一化结果，避免 runner 分散判断优先级：

```typescript
interface CaseDeviceSelection {
  devices: string[];
  deviceSuiteOverrides?: Record<string, string[]>;
  runAllTests: boolean;
}
```

当 `runAllTests` 为 `true` 时，不向 `runOhosTestMatrix()` 传入 `deviceSuiteOverrides`，并确保 case 模式不会把 `machine.json.devices[].testSuites` 当作默认 suite。实现上可在 `RunMatrixInput` 增加：

```typescript
ignoreMachineDeviceSuites?: boolean;
```

case 全量场景调用矩阵 runner 时设置 `ignoreMachineDeviceSuites: true`。

## 错误处理

新增或复用 blocked reason：

```typescript
type CaseBlockedReason =
  | "metadata_device_missing_in_machine"
  | "metadata_device_has_no_suites"
  | "metadata_enabled_devices_invalid"
  | "case_device_cli_not_supported";
```

`device_test_suites` 一旦存在，继续要求每台设备至少有一个 suite。只有该字段不存在时，才进入 `enabled_devices` 或 `machine.json.devices` 的全量测试降级路径。

## 测试计划

新增 `tests/case-config.test.ts` 覆盖：

- 有 `device_test_suites` 时保持原 suite 覆盖行为。
- 无 `device_test_suites`、有 `enabled_devices` 时，只选择 enabled 设备并全量测试。
- 两个字段都不存在时，选择 machine 中全部设备并全量测试。
- `enabled_devices` 设备不存在于 machine 时失败。
- case CLI 收到 `--device` 时失败。
- 全量测试场景不读取 `machine.json.devices[].testSuites`。

## 验收标准

1. 旧 case metadata 只包含 `device_test_suites` 时行为不变。
2. metadata 只包含 `enabled_devices: ["phone", "foldable"]` 时，仅 phone 和 foldable 执行全量测试。
3. metadata 不包含 `device_test_suites` 和 `enabled_devices` 时，`machine.json.devices` 中所有设备执行全量测试。
4. case 全量测试场景不会使用 `machine.json.devices[].testSuites` 作为 suite 过滤。
5. 现有 matrix 模式行为保持兼容。
