# HAP 模块发现与 Case 单用例超时设计

## 背景

runner 当前通过模块名等于 `entry`、模块路径包含 `entry` 或项目首个模块来选择 ohosTest 所属模块。这会使 HAP 模块名为 `phone` 或其他名称的工程选择错误。

`aa test` 命令的 `-s timeout` 当前固定使用 `AA_TEST_CASE_TIMEOUT_MS = 15000`。case 模式无法针对耗时较长的用例调整该值。

## 目标

1. 根据模块实际使用的 Hvigor HAP 插件发现 ohosTest 所属模块，不依赖模块名称或目录名称。
2. 允许 case 的 `metadata.json` 配置单用例超时，并覆盖默认的 `AA_TEST_CASE_TIMEOUT_MS`。
3. 保持未配置超时的 case 和普通 matrix 模式行为不变。
4. 使用 `ResponsiveRepeatLayout/case` 作为真实工程验证样例。

## 非目标与约束

- 本次不支持一个工程包含多个 HAP 模块。
- runner 使用文档明确声明：自动发现模块时，工程必须且只能包含一个 HAP 模块。
- 本次不在 `machine.json` 中增加单用例超时配置。
- 本次不改变 `timeoutMs` 对应的 `aa test -w` 整体命令等待时间。

## HAP 模块发现

`discoverProjectInfo()` 读取根 `build-profile.json5` 中对当前 product 生效的模块。对每个候选模块：

1. 规范化 `srcPath`。
2. 读取模块根目录下的 `hvigorfile.ts`。
3. 将使用 `hapTasks` 的模块识别为 HAP 模块。

选择结果必须恰好包含一个模块：

- 没有 HAP 模块时抛出包含工程路径的明确错误。
- 存在多个 HAP 模块时抛出包含匹配模块名的明确错误。
- 恰好一个时，以该模块的名称和 `srcPath` 推导 ohosTest 配置、构建命令和 HAP 产物路径。

现有按 `entry` 名称、路径和首模块回退的逻辑删除。共享模块发现逻辑保持不变。

## Case 单用例超时

`metadata.json` 新增可选字段：

```json
{
  "test_case_timeout_ms": 30000
}
```

字段约束：

- 单位为毫秒。
- 值必须是大于 0 的整数。
- 缺省时使用 `AA_TEST_CASE_TIMEOUT_MS`，当前为 15000ms。
- 非数字、非整数、零和负数均在读取 metadata 时明确报错。

解析后的 `CaseMetadata` 保存最终生效的 `testCaseTimeoutMs`。case runner 将该值沿以下链路显式传递：

```text
runOhosTestCase
  -> runOhosTestMatrix
  -> loadMatrixConfig
  -> MatrixConfig
  -> buildAaTestCommand
  -> aa test -s timeout <testCaseTimeoutMs>
```

普通 matrix 模式没有 case metadata，继续使用 `AA_TEST_CASE_TIMEOUT_MS`。case 结果的 metadata 中记录最终生效的 `testCaseTimeoutMs`，便于复现和审计。

## 错误处理

- HAP 模块发现不进行猜测或静默回退。
- 无 HAP 和多 HAP 使用不同、可检索的错误消息。
- `test_case_timeout_ms` 校验失败时指出完整字段名 `metadata.test_case_timeout_ms` 及正整数要求。
- 元数据缺省超时不是错误。

## 测试与验证

测试先于实现，覆盖以下行为：

1. HAP 模块名为 `phone`、路径不含 `entry`，且不是首模块时仍能正确发现。
2. 无 HAP 模块时发现失败。
3. 多 HAP 模块时发现失败并列出匹配模块。
4. `loadCaseMetadata()` 读取合法的 `test_case_timeout_ms`。
5. 缺省时得到 15000ms。
6. 非整数、零和负数被拒绝。
7. case 模式生成的 `aa test` 命令使用 metadata 中的超时。
8. 普通 matrix 模式生成的命令继续使用 15000ms。
9. TypeScript 构建、lint 和全量单元测试通过。
10. 在 `ResponsiveRepeatLayout/case/metadata.json` 增加超时配置，并以该 case 执行 runner 验证模块发现和命令参数。

真实 case 验证需要设备或模拟器时，至少验证配置加载、构建和命令日志；若运行环境具备目标设备，则完成端到端 case 执行。

## 文档更新

- case 使用文档增加 `test_case_timeout_ms` 的字段说明、单位、默认值和示例。
- matrix 使用文档将 “entry module” 改为 “HAP module”，说明通过 `hvigorfile.ts` 中的 `hapTasks` 自动发现。
- 使用文档明确当前自动发现仅支持单 HAP 工程。
