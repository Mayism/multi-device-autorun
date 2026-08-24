# case 报告按用例维度汇总设计

## 背景

case runner 当前 summary 中的 `Device Results` 仍保留 suite 维度汇总，并且历史实现曾通过 suite class 名称是否包含 `FailToPass` 推断 `pass_to_pass` / `fail_to_pass` 分类。这会带来两个问题：

- 分类依赖命名约定，而不是 `metadata.json` 中的权威用例清单。
- suite 维度结果会掩盖单个 test case 的实际执行情况，不利于定位具体失败用例。

新版报告需要以单个 test case 为基本行，保留 suite 信息作为定位辅助，同时让 totals 只表达设备级整体判定。

## 目标

1. `Device Results` 不再输出 suite 维度结果表。
2. 每个设备下直接列举该设备执行到的每个 test case。
3. 每条 test case 行增加所属 suite 列，便于定位。
4. test case 的 `pass_to_pass` / `fail_to_pass` 分类只来自 `metadata.json`。
5. `Totals` 只写设备级整体判定，不再按 `pass_to_pass` / `fail_to_pass` 分类统计。
6. 保留 `--run swe`、`--run answer`、`--run all` 三种运行模式的不同期望规则。

## 非目标

- 不修改 ohosTest 输出解析逻辑。
- 不修改 matrix 级 `result.json` schema。
- 不继续兼容通过 suite class 名称推断分类的旧语义。
- 不要求 suite 名称遵循 `PassToPass` / `FailToPass` 命名。

## 分类规则

分类以 `metadata.json` 中的 test case name 为唯一来源：

- `metadata.pass_to_pass` 中的 test case 归为 `pass_to_pass`。
- `metadata.fail_to_pass` 中的 test case 归为 `fail_to_pass`。
- 同时出现在两个数组中的 test case 归为 `conflict`。
- 未出现在任一数组中的 test case 归为 `unclassified`。

`conflict` 和 `unclassified` 都不能判为正确，summary 中需要显式展示，避免静默误判。

## Device Results 表格

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

如果某个 suite 没有解析到 test case 明细，输出一行 fallback：

```markdown
| MdAdaptiveTest | none parsed | unclassified | failed, 0/2, failures=2 | metadata category required | incorrect |
```

## 期望与判定

### `--run swe`

- `pass_to_pass`: 期望 `SWE pass`，实际 `passed` 时为 `correct`。
- `fail_to_pass`: 期望 `SWE fail`，实际 `failed` 时为 `correct`。
- `unclassified` / `conflict`: 期望 `metadata category required`，固定 `incorrect`。

### `--run answer`

- `pass_to_pass`: 期望 `Answer pass`，实际 `passed` 时为 `correct`。
- `fail_to_pass`: 期望 `Answer pass`，实际 `passed` 时为 `correct`。
- `unclassified` / `conflict`: 期望 `metadata category required`，固定 `incorrect`。

### `--run all`

- `pass_to_pass`: 期望 `SWE pass, Answer pass`，两侧都 `passed` 时为 `correct`。
- `fail_to_pass`: 期望 `SWE fail, Answer pass`，SWE 为 `failed` 且 Answer 为 `passed` 时为 `correct`。
- `unclassified` / `conflict`: 期望 `metadata category required`，固定 `incorrect`。

## Totals 表格

`Totals` 只按设备和运行侧输出整体判定，不再按 `pass_to_pass` / `fail_to_pass` 分列。

单跑 `swe` 或 `answer`：

```markdown
## Totals

| Device | Run | Tests | Correct | Incorrect | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| phone | swe | 11 | 11 | 0 | correct |
| foldable | swe | 13 | 13 | 0 | correct |
| tablet | swe | 11 | 11 | 0 | correct |
```

双跑 `all` 时，每台设备分别输出 `swe` 和 `answer` 两行：

```markdown
## Totals

| Device | Run | Tests | Correct | Incorrect | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| phone | swe | 11 | 11 | 0 | correct |
| phone | answer | 11 | 11 | 0 | correct |
| foldable | swe | 13 | 13 | 0 | correct |
| foldable | answer | 13 | 13 | 0 | correct |
| tablet | swe | 11 | 11 | 0 | correct |
| tablet | answer | 11 | 11 | 0 | correct |
```

设备级 `Verdict` 规则：

- `incorrect` 为 0 时是 `correct`。
- `incorrect` 大于 0 时是 `incorrect`。
- 设备未执行时不输出该设备行。

## 实现计划

1. 在 `result.ts` 中新增基于 metadata 的 test case 分类函数。
2. 删除报告层对 `suiteClass.includes("FailToPass")` 的依赖。
3. 将 `Device Results` 渲染改为按 device 展开 test case 行。
4. 将 `Totals` 改为设备加运行侧的整体判定表；`all` 模式每台设备输出 `swe` 和 `answer` 两行。
5. 更新 `case-result.test.ts`：
   - 覆盖 metadata 分类而非 suite 命名分类。
   - 覆盖 `swe`、`answer`、`all` 三种模式。
   - 覆盖 `unclassified` 和 `conflict`。
6. 更新 `docs/usage/case.md` 中的报告示例和分类规则说明。

## 验收

- suite class 即使包含 `FailToPass`，只要 test case 不在 `metadata.fail_to_pass` 中，就不能归为 `fail_to_pass`。
- suite class 不包含 `FailToPass`，只要 test case 在 `metadata.fail_to_pass` 中，就必须归为 `fail_to_pass`。
- `Device Results` 每行都是 test case，不再出现 suite 级结果行。
- 每行 test case 都包含 `Suite` 列。
- `Totals` 按设备和运行侧给出整体 `correct` / `incorrect`；`all` 模式区分 `swe` 和 `answer`。
- `npm test`、`npm run build`、`npm run lint` 通过。
- 用 `ResponsiveRepeatLayout/case` 至少验证 `--run swe` 和 `--run answer` 的真实 summary。
