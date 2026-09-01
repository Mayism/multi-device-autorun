# HSP 安装与干净构建设计

## 背景

当前 runner 的矩阵执行链路只建模两个安装产物：

- 应用 HAP。
- ohosTest HAP。

`assembleApp` 能够为工程中的 shared 模块构建 HSP，但项目发现、构建结果校验和设备安装都没有保存或使用这些 HSP。设备安装命令固定为：

```text
hdc install -r <app-hap> <test-hap>
```

当应用或测试 HAP 依赖 HSP 时，设备端会拒绝安装。例如
`livestreaming-template-derive-base` 的 `entry` 和 `entry_test` 都依赖
shared 模块 `common`，实际安装输出为：

```text
code:9568305 error: Failed to install the HAP or HSP because the dependent module does not exist.
entry_test's dependent module: common does not exist
entry's dependent module: common does not exist
```

该版本的 `hdc install` 即使输出上述业务错误，进程退出码仍然为 `0`。runner
当前只判断退出码，因此会继续执行 `aa test`，最终以“应用未安装”和“没有解析出测试用例”
结束。这个结果掩盖了真正的安装失败。

此外，主构建直接复用 Hvigor 的增量缓存。连续执行不同 case 或同一 case 的 SWE/Answer
轮次时，上一轮编译产物和缓存可能影响本轮结果。

## 目标

1. 自动发现当前 product 下所有适用的 shared 模块。
2. 在主构建结束后解析并校验这些模块的 HSP 产物。
3. 按 shared 模块依赖顺序逐个安装 HSP，再安装应用 HAP 和 ohosTest HAP。
4. 在 `hdc` 退出码为 `0` 时仍能识别 AppMod 输出中的安装失败。
5. 安装失败后将设备阻断为 `install_failed`，不得继续执行 `aa test`。
6. 每次主构建开始时执行一次 `hvigorw clean`，消除上一轮构建缓存影响。
7. 保持纯 HAP 工程、现有 CLI、配置文件和结果报告结构兼容。

## 非目标

- 不解析应用的业务依赖图，只识别工程配置中适用于当前 product 的 shared 模块。
- 不修改 `machine.json` 或 case metadata 的格式。
- 不增加 `result.json`、`summary.md` 或 `BuildResult` 的 HSP 字段。
- 不改变测试通过、失败和 ignored 的判定规则。
- 不在折叠屏流程的 test HAP 增量重构建前执行 clean。
- 不解决签名、证书或设备版本不兼容导致的其他安装问题。

## 方案比较

### 方案一：模块感知发现并在构建后校验

读取根 `build-profile.json5` 的模块列表，再读取每个模块的
`src/main/module.json5`。`module.type === "shared"` 且适用于当前 product
的模块进入 HSP 产物清单。构建完成后只在这些模块的当前 product 输出目录中解析 HSP。

优点：

- 不会误装其他 product 或其他模块的旧产物。
- 可以在 `--skip-build` 模式下执行同样的产物校验。
- 支持任意数量和任意 `srcPath` 的 shared 模块。
- 与现有项目发现逻辑一致，结果稳定且可测试。

缺点：

- 需要扩展内部项目发现和构建执行数据结构。
- 工程模块声明错误时会明确阻断，而不会退化为全局搜索。

本设计采用该方案。

### 方案二：构建后全工程扫描 HSP

递归查找所有 `**/build/**/outputs/**/*.hsp`。

实现简单，但可能拾取旧 product、另一种签名或不参与当前应用的模块产物，无法保证安装
清单确定，因此不采用。

### 方案三：解析 APP 包内容

读取 `.app` 包或打包描述获得其 HSP 列表，再映射到本地产物。

该方案接近最终发布包语义，但依赖 APP 格式细节，复杂度和维护成本超过当前需求，因此不采用。

## 项目发现

### 模块模型

扩展内部 `ProjectModuleInfo`，读取模块 targets：

```typescript
interface ProjectModuleTarget {
  name?: string;
  applyToProducts?: string[];
}

interface ProjectModuleInfo {
  name?: string;
  srcPath?: string;
  targets?: ProjectModuleTarget[];
}
```

新增只在 runner 内部使用的 shared 模块描述：

```typescript
interface SharedModuleInfo {
  name: string;
  srcPath: string;
  outputDir: string;
  packageName: string;
  dependencies: string[];
}
```

`ProjectInfo` 增加 `sharedModules: SharedModuleInfo[]`。该字段仅用于构建和安装编排，
不会直接写入报告。

### shared 模块选择规则

按根 `build-profile.json5.modules` 的原始顺序处理模块：

1. `name` 和 `srcPath` 必须是非空字符串。
2. 读取 `<project>/<srcPath>/src/main/module.json5`。
3. 只有 `module.type === "shared"` 的模块进入后续判断。
4. 模块没有声明 `targets` 时，视为适用于当前 product。
5. 模块声明了 targets 时，只要任一 target 的 `applyToProducts` 包含当前 product，
   即视为适用。
6. targets 存在但没有任何 target 适用于当前 product 时跳过该模块。
7. 读取模块根目录的 `oh-package.json5`，记录 package name 和 dependencies。

缺失或无法解析 `src/main/module.json5` 时，项目发现直接失败并指出模块名和文件路径；
runner 不应猜测模块类型。

每个 shared 模块的输出目录为：

```text
<module-src-path>/build/<product>/outputs/<product>/
```

## HSP 产物解析

### 签名类型

现有 runner 默认使用 unsigned 应用 HAP，同时允许通过现有 artifacts 配置覆盖 HAP
路径。HSP 必须与实际应用 HAP 使用相同签名类型：

- 应用文件名以 `-unsigned.hap` 结尾时，选择 `-unsigned.hsp`。
- 应用文件名以 `-signed.hap` 结尾时，选择 `-signed.hsp`。
- 应用文件名无法判断签名类型时，构建结果阻断并在 diagnostics 中说明原因。

### 候选选择

对每个 `SharedModuleInfo`：

1. 读取该模块的 `outputDir`。
2. 只接受扩展名为 `.hsp` 且签名后缀与应用 HAP 一致的普通文件。
3. 不递归扫描 outputDir 的子目录。
4. 候选为一个时使用该文件。
5. 候选为空时阻断构建，diagnostics 记录模块名、输出目录和预期签名后缀。
6. 候选多于一个时阻断构建，diagnostics 记录模块名和全部候选路径。

shared 模块按 `oh-package.json5.dependencies` 做稳定拓扑排序：被依赖的 shared 模块排在
依赖方之前；没有依赖关系的模块保持根 build profile 的相对顺序。依赖环会在项目发现
阶段明确失败。HSP 解析结果使用该顺序，使安装命令和日志稳定。

## 构建流程

### 主构建命令

未启用 `--skip-build` 时，主构建严格按以下顺序执行：

```text
hvigorw clean --no-daemon
ohpm install
hvigorw --mode <mode> -p product=<product> <app-task> ... --no-daemon
hvigorw --mode module -p module=<entry>@ohosTest <test-task> --no-daemon --stacktrace
```

clean 使用 `config.paths.hvigorw`，与其他 Hvigor 命令保持相同的路径解析和 shell
转义规则。

任一命令退出码非零时：

- 构建立即停止。
- 使用现有 `build_failed`。
- 不解析安装产物。
- 不启动任何设备。

clean 只在每次 matrix 主构建开头执行一次。case 模式的 SWE 和 Answer 各自调用一次
matrix 主构建，因此两轮分别 clean，避免 SWE 构建缓存影响 Answer。

### skip-build

`--skip-build=true` 时：

- 不执行 clean。
- 不执行 ohpm install。
- 不执行 app 或 test HAP 构建。
- 仍然校验 app HAP、test HAP，并解析、校验全部 HSP。

### 折叠屏 test HAP 重构建

折叠屏流程部署测试触发代码后，会单独调用 `buildTestHapCommand()` 重构建 test HAP。
该命令前不执行 clean。否则 clean 会删除主构建刚生成的应用 HAP 和 HSP，导致随后安装
再次缺少产物。

## 内部数据流

结果报告继续使用现有 `BuildResult`，不增加字段。构建编排新增内部返回类型：

```typescript
interface InstallArtifacts {
  hspPaths: string[];
  appHap: string;
  testHap: string;
}

interface BuildOutcome {
  result: BuildResult;
  installArtifacts?: InstallArtifacts;
}
```

规则：

- 构建和全部产物校验成功时，返回 `result.status === "passed"` 和
  `installArtifacts`。
- 纯 HAP 工程返回空的 `hspPaths`。
- 构建或产物校验失败时不返回 `installArtifacts`。
- 写入 `result.json` 时只使用 `BuildOutcome.result`。
- 设备执行阶段只接收已经校验过的 `InstallArtifacts`。

这样既避免把内部安装清单暴露到报告，也避免设备阶段重新扫描文件系统。

## 安装流程

真实设备验证表明，HDC 对一个包含多个 HSP/HAP 的 `install -r` 命令按反向参数顺序
逐包处理，不会在整批文件之间解析依赖。因此 `installHaps()` 调整为接受
`InstallArtifacts`，并按以下顺序执行多个安装命令：

```text
hdc install -r <dependency-hsp-1>
hdc install -r <dependent-hsp-2>
...
hdc install -r <app-hap> <test-hap>
```

每个 HSP 成功后才安装下一个；任一 HSP 失败立即停止。全部 HSP 安装成功后，应用 HAP
和测试 HAP 在同一个命令中提交。纯 HAP 工程的命令保持为：

```text
hdc install -r <app-hap> <test-hap>
```

安装前继续卸载当前 bundle。卸载不存在的 bundle 仍可失败，不影响后续安装。

## 安装失败识别

新增独立、可单元测试的判定函数：

```typescript
function isInstallFailure(result: CommandResult): boolean {
  if (result.exitCode !== 0) {
    return true;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  return /msg:error:|error:\s*failed to install|failed to install the HAP or HSP/i.test(
    output,
  );
}
```

检查范围只包含 `hdc install` 的结果，不把允许忽略的 uninstall 输出传入该函数。
不强制匹配某个成功文本，因为不同 HDC 版本的成功输出可能不同；退出码为零且没有已知
安装失败标记即视为成功。

检测到失败时：

1. `installHaps()` 抛出 `Error("install_failed")`。
2. 现有 `reasonFromError()` 将其映射为 `blockedReason: "install_failed"`。
3. 当前设备立即结束，不调用任何 `aa test`。
4. 完整命令、stdout 和 stderr 继续保存在 `commands.log`。
5. `devices/<device>.log` 记录 `install_failed`，不把后续“应用未安装”误报为测试错误。

## 报告兼容性

以下对外结构保持不变：

- `ohostest-matrix-v1`。
- `BuildResult`。
- `MatrixResult`。
- case 级 result。
- summary 表格。
- CLI 参数。
- machine 配置。

HSP 缺失或歧义使用现有 `diagnostics` 和 `BuildResult.blockedReason` 表达，不新增字段。
安装失败继续使用现有设备 `blockedReason: "install_failed"`。

## 预计修改文件

- `src/matrix/utils/projectDiscovery.ts`
  - 发现适用于当前 product 的 shared 模块和输出目录。
- `src/matrix/types/index.ts`
  - 增加内部 shared 模块和安装产物相关类型；不改变序列化报告接口。
- `src/matrix/build.ts`
  - 在主构建前执行 clean。
  - 构建后解析、校验 HSP。
  - 返回内部 `BuildOutcome`。
- `src/matrix/device.ts`
  - 安装全部 HSP 与两个 HAP。
  - 识别退出码为零的 AppMod 安装失败。
- `src/matrix/runner.ts`
  - 将内部 `InstallArtifacts` 从构建阶段传给设备阶段。
  - 报告仍只写入原有 `BuildResult`。
- `tests/project-discovery.test.ts`
  - 覆盖 shared 模块发现和 product 过滤。
- `tests/build.test.ts`
  - 覆盖 clean 顺序、HSP 解析、skip-build 和产物异常。
- `tests/device.test.ts`
  - 覆盖 HSP 安装命令和 AppMod 业务失败识别。
- `tests/runner.test.ts`
  - 覆盖端到端内部产物传递以及安装失败后不执行测试。
- `docs/usage/matrix.md`
  - 说明 shared 模块自动安装和主构建 clean 行为。
- `docs/usage/case.md`
  - 说明 SWE/Answer 每轮都会独立 clean。
- `CHANGELOG.md`
  - 记录 HSP 工程支持和干净构建行为变更。

如果现有测试组织更适合把构建测试保留在 `runner.test.ts`，实现时可以不新增
`tests/build.test.ts`；测试场景和行为要求不能省略。

## 测试策略

### 项目发现单元测试

1. entry-only 工程得到空 shared 模块列表。
2. `module.type === "shared"` 的模块被发现。
3. feature、har 等非 shared 模块不会进入 HSP 清单。
4. `srcPath` 带 `./` 时能正确归一化。
5. 没有 targets 的 shared 模块适用于当前 product。
6. targets 包含当前 product 时保留模块。
7. targets 不包含当前 product 时跳过模块。
8. shared 模块的 module.json5 缺失或无法解析时给出明确错误。
9. 多个 shared 模块按依赖拓扑顺序返回，无依赖关系时保持根 build profile 相对顺序。
10. shared 模块依赖环会给出明确错误。

### 构建与产物测试

1. 未 skip-build 时，第一条命令是
   `hvigorw clean --no-daemon`。
2. 命令顺序严格为 clean、ohpm install、assembleApp、test HAP 构建。
3. clean 失败后不执行任何后续命令。
4. `--skip-build=true` 时不执行 clean 或其他构建命令。
5. 纯 HAP 工程构建成功并产生空 HSP 安装清单。
6. unsigned app HAP 只选择 unsigned HSP。
7. signed app HAP 只选择 signed HSP。
8. HSP 缺失时构建阻断，diagnostics 包含模块名和输出目录。
9. 同一 shared 模块有多个匹配候选时构建阻断，并列出候选。
10. 非当前 product 目录中的 HSP 不会被选中。
11. 构建报告 JSON 不出现 `hspPaths` 或其他新增 HSP 字段。

### 设备安装单元测试

1. 纯 HAP 工程保持原安装命令。
2. 一个 HSP 时先单独安装 HSP，再安装 app HAP 和 test HAP。
3. 多个 HSP 按依赖顺序逐个安装，所有路径经过 shellQuote。
4. install 退出码非零时抛出 `install_failed`。
5. install 退出码为零但 stdout 包含 `msg:error:` 时抛出
   `install_failed`。
6. 本次真实故障文本 `code:9568305 ... dependent module does not exist`
   被判定为安装失败。
7. 相同失败文本出现在 stderr 时同样被识别。
8. 正常退出码和正常输出不会误判。
9. uninstall 失败仍然继续执行 install。

### runner 集成测试

1. 构建阶段解析出的多个 HSP 被传入每台设备，不在设备阶段重新发现。
2. 任一 HSP 缺失时不启动模拟器或设备。
3. 安装业务失败时设备结果为 blocked/install_failed。
4. 安装业务失败后命令列表中不存在 `aa test`。
5. HAP-only fixture 的现有成功路径保持通过。
6. case 模式无需额外逻辑即可复用 HSP 安装。
7. 折叠屏 test HAP 增量重构建前不存在额外 clean。

### 真实回归验证

使用：

```text
/Users/guoyutong/temp/case-output-derive-base
```

执行两次：

```bash
npm run ohostest:case -- \
  --case /Users/guoyutong/temp/case-output-derive-base \
  --run answer \
  --device phone \
  --out <独立输出目录>
```

每次验证：

1. commands.log 的主构建第一条 Hvigor 命令是 clean。
2. assembleApp 日志包含 shared 模块 HSP 构建。
3. install 命令按依赖顺序逐个安装所有当前 product 的 HSP，最后安装 app HAP 和 test HAP。
4. install 输出不包含 `9568305` 或 dependent module missing。
5. `aa test` 实际执行。
6. `SmPassToPass` 用例能够解析，不再出现 `none parsed`。
7. 两次结果中的测试集合、状态和统计一致。

## 验收标准

1. 含一个或多个 HSP 的工程可以自动发现并安装当前 product 的全部 shared 模块。
2. 本次复现工程连续执行两次 phone/answer，不再出现 `common does not exist`。
3. 每次主构建只在开头 clean 一次。
4. SWE 和 Answer 分别 clean，互不复用上一轮构建缓存。
5. skip-build 和折叠屏 test HAP 增量重构建不 clean。
6. `hdc install` 返回退出码零但输出 AppMod 错误时，设备被阻断为
   `install_failed`，且不执行 `aa test`。
7. 纯 HAP 工程的安装命令和执行结果保持兼容。
8. result 和 summary 不增加 HSP 字段。
9. runner 的单元测试、TypeScript 构建和 lint 全部通过。
