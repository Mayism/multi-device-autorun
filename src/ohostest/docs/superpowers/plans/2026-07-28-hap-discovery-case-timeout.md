# HAP Discovery and Case Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover the single HAP module by its Hvigor plugin and allow `metadata.json` to override the per-test `aa test -s timeout` value.

**Architecture:** Project discovery will inspect each root module's `hvigorfile.ts` and require exactly one module that uses `hapTasks`. Case metadata will normalize `test_case_timeout_ms` to an effective positive integer and pass it explicitly through the existing case-to-matrix configuration chain; matrix-only callers retain the 15000ms default.

**Tech Stack:** TypeScript, Node.js test runner, JSON/JSON5 HarmonyOS project configuration, Hvigor.

---

## File Structure

- Modify `src/matrix/utils/projectDiscovery.ts`: identify the single HAP module from `hvigorfile.ts`.
- Modify `src/matrix/ohostest.ts`: accept a configurable per-test timeout while retaining the exported default.
- Modify `src/matrix/config.ts`: normalize the matrix run's effective per-test timeout.
- Modify `src/matrix/types/index.ts`: carry the timeout through matrix input and configuration.
- Modify `src/matrix/runner.ts`: pass the configured timeout into the AA command.
- Modify `src/case/config.ts`: parse and validate `metadata.test_case_timeout_ms`.
- Modify `src/case/types/index.ts`: carry the effective timeout in case metadata and results.
- Modify `src/case/runner.ts`: pass the case timeout into each matrix phase.
- Modify `src/case/result.ts`: persist the effective timeout in result metadata.
- Modify `tests/project-discovery.test.ts`: cover renamed, missing, and multiple HAP modules.
- Modify `tests/config.test.ts`, `tests/runner.test.ts`, and `tests/case-runner.test.ts`: add realistic `hapTasks` fixtures.
- Modify `tests/ohostest.test.ts`, `tests/case-config.test.ts`, and `tests/case-runner.test.ts`: cover default, override, validation, and end-to-end command propagation.
- Modify `docs/usage/matrix.md` and `docs/usage/case.md`: document discovery and timeout contracts.
- Modify `ResponsiveRepeatLayout/case/metadata.json`: configure the real case timeout to 30000ms.

### Task 1: Discover the HAP Module by Hvigor Plugin

**Files:**
- Modify: `harmonyos-ohostest-runner/tests/project-discovery.test.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/utils/projectDiscovery.ts`
- Modify: `harmonyos-ohostest-runner/tests/config.test.ts`
- Modify: `harmonyos-ohostest-runner/tests/runner.test.ts`
- Modify: `harmonyos-ohostest-runner/tests/case-runner.test.ts`

- [ ] **Step 1: Write failing HAP discovery tests**

Extend `ModuleFixture` with `packageType: "hap" | "har" | "hsp"` and make `makeProject()` write each module's plugin:

```typescript
await fs.writeFile(
  path.join(project, module.srcPath, "hvigorfile.ts"),
  [
    `import { ${module.packageType}Tasks } from '@ohos/hvigor-ohos-plugin';`,
    `export default { system: ${module.packageType}Tasks, plugins: [] };`,
    "",
  ].join("\n"),
  "utf-8",
);
```

Create the ohosTest module under the fixture whose `packageType` is `hap`, rather than the fixture named `entry`, and use the HAP fixture name:

```typescript
JSON.stringify({ module: { name: `${hap.name}_test` } })
```

When a no-HAP fixture is needed, do not create an ohosTest directory. Add three tests:

```typescript
test("discoverProjectInfo selects a renamed HAP module instead of the first module", async (t) => {
  const project = await makeProject(t, [
    { name: "library", srcPath: "commons/library", type: "har", packageType: "har" },
    { name: "phone", srcPath: "products/phone", type: "entry", packageType: "hap" },
  ]);

  const info = await discoverProjectInfo(project);

  assert.equal(info.moduleName, "phone");
  assert.equal(info.moduleSrcPath, "products/phone");
  assert.equal(info.testModuleName, "phone_test");
  assert.match(info.appHap, /products\/phone\/build\/default\/outputs\/default\/phone-default-unsigned\.hap$/);
});

test("discoverProjectInfo rejects a project without a HAP module", async (t) => {
  const project = await makeProject(t, [
    { name: "library", srcPath: "commons/library", type: "har", packageType: "har" },
  ]);
  await assert.rejects(discoverProjectInfo(project), /project_hap_module_not_found/);
});

test("discoverProjectInfo rejects multiple HAP modules", async (t) => {
  const project = await makeProject(t, [
    { name: "phone", srcPath: "products/phone", type: "entry", packageType: "hap" },
    { name: "tablet", srcPath: "products/tablet", type: "feature", packageType: "hap" },
  ]);
  await assert.rejects(
    discoverProjectInfo(project),
    /project_hap_module_ambiguous: phone, tablet/,
  );
});
```

Update existing fixture declarations to specify their package type.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test \
  --test-name-pattern="HAP module" \
  harmonyos-ohostest-runner/tests/project-discovery.test.ts
```

Expected: FAIL because discovery still selects `entry`/the first module and does not reject zero or multiple HAP modules.

- [ ] **Step 3: Implement single-HAP discovery**

Replace `selectEntryModule()` with asynchronous HAP discovery:

```typescript
async function selectHapModule(
  project: string,
  product: string,
  modules: ProjectModuleInfo[],
): Promise<ProjectModuleInfo> {
  const matches: ProjectModuleInfo[] = [];
  for (const moduleInfo of modules) {
    if (!appliesToProduct(moduleInfo, product)) continue;
    const name = moduleInfo.name?.trim();
    const rawSrcPath = moduleInfo.srcPath?.trim();
    if (!name || !rawSrcPath) continue;
    const hvigorfile = await fs.readFile(
      path.join(project, normalizeModuleSrcPath(rawSrcPath), "hvigorfile.ts"),
      "utf-8",
    );
    if (/\bhapTasks\b/.test(hvigorfile)) matches.push(moduleInfo);
  }
  if (matches.length === 0) {
    throw new Error(`project_hap_module_not_found: ${project}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `project_hap_module_ambiguous: ${matches.map((item) => item.name).join(", ")}`,
    );
  }
  return matches[0]!;
}
```

Call it from `discoverProjectInfo()`:

```typescript
const moduleInfo = await selectHapModule(
  project,
  product,
  buildProfile.modules ?? [],
);
```

Remove the name/path/first-module fallback.

- [ ] **Step 4: Update integration fixtures and verify GREEN**

Write a minimal `hapTasks` `hvigorfile.ts` in `makeTempProject()` (`tests/config.test.ts`), `makeProject()` (`tests/case-runner.test.ts`), `makeProject()` and `makeProjectWithoutWrapper()` (`tests/runner.test.ts`):

```typescript
await fs.writeFile(
  path.join(moduleRoot, "hvigorfile.ts"),
  "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n",
  "utf-8",
);
```

Run:

```bash
node --import tsx --test \
  --test-name-pattern="HAP module|loadMatrixConfig infers|runOhosTestMatrix builds|runOhosTestCase applies" \
  harmonyos-ohostest-runner/tests/project-discovery.test.ts \
  harmonyos-ohostest-runner/tests/config.test.ts \
  harmonyos-ohostest-runner/tests/runner.test.ts \
  harmonyos-ohostest-runner/tests/case-runner.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit HAP discovery**

```bash
git add harmonyos-ohostest-runner/src/matrix/utils/projectDiscovery.ts \
  harmonyos-ohostest-runner/tests/project-discovery.test.ts \
  harmonyos-ohostest-runner/tests/config.test.ts \
  harmonyos-ohostest-runner/tests/runner.test.ts \
  harmonyos-ohostest-runner/tests/case-runner.test.ts
git commit -m "fix: discover renamed HAP modules"
```

### Task 2: Parse and Validate the Case Timeout

**Files:**
- Modify: `harmonyos-ohostest-runner/tests/case-config.test.ts`
- Modify: `harmonyos-ohostest-runner/src/case/config.ts`
- Modify: `harmonyos-ohostest-runner/src/case/types/index.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/ohostest.ts`

- [ ] **Step 1: Write failing metadata tests**

Import `AA_TEST_CASE_TIMEOUT_MS` in `case-config.test.ts`. Add `test_case_timeout_ms: 30000` to the complete metadata fixture and assert:

```typescript
assert.equal(metadata.testCaseTimeoutMs, 30000);
```

Add a default test and table-driven invalid tests:

```typescript
assert.equal(metadata.testCaseTimeoutMs, AA_TEST_CASE_TIMEOUT_MS);

for (const value of [0, -1, 1.5, "30000"]) {
  await assert.rejects(
    loadCaseMetadata(caseDir),
    /metadata\.test_case_timeout_ms must be a positive integer/,
  );
}
```

Each invalid iteration rewrites the fixture metadata with the current value.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test harmonyos-ohostest-runner/tests/case-config.test.ts
```

Expected: FAIL because `CaseMetadata` has no `testCaseTimeoutMs` and the raw field is ignored.

- [ ] **Step 3: Implement metadata normalization**

Add the raw and normalized fields:

```typescript
interface RawCaseMetadata {
  test_case_timeout_ms?: unknown;
}

export interface CaseMetadata {
  testCaseTimeoutMs: number;
}
```

Export the default constant from `matrix/ohostest.ts` as today and add:

```typescript
function readTestCaseTimeoutMs(value: unknown): number {
  if (value === undefined) return AA_TEST_CASE_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      "metadata.test_case_timeout_ms must be a positive integer.",
    );
  }
  return value;
}
```

Set `testCaseTimeoutMs: readTestCaseTimeoutMs(raw.test_case_timeout_ms)` in `loadCaseMetadata()`.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --import tsx --test harmonyos-ohostest-runner/tests/case-config.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit metadata parsing**

```bash
git add harmonyos-ohostest-runner/src/case/config.ts \
  harmonyos-ohostest-runner/src/case/types/index.ts \
  harmonyos-ohostest-runner/tests/case-config.test.ts
git commit -m "feat: parse case test timeout"
```

### Task 3: Propagate the Timeout to `aa test`

**Files:**
- Modify: `harmonyos-ohostest-runner/tests/ohostest.test.ts`
- Modify: `harmonyos-ohostest-runner/tests/config.test.ts`
- Modify: `harmonyos-ohostest-runner/tests/case-runner.test.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/ohostest.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/config.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/types/index.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/runner.ts`
- Modify: `harmonyos-ohostest-runner/src/case/runner.ts`
- Modify: `harmonyos-ohostest-runner/src/case/result.ts`
- Modify: `harmonyos-ohostest-runner/src/case/types/index.ts`

- [ ] **Step 1: Write a failing AA command unit test**

Add:

```typescript
test("buildAaTestCommand uses an explicit per-test timeout", () => {
  const command = buildAaTestCommand({
    hdc: "/fake/hdc",
    target: "127.0.0.1:15001",
    bundleName: "zhsc.1.xxxxxx",
    testModule: "phone_test",
    testRunner: "OpenHarmonyTestRunner",
    testCaseTimeoutMs: 30000,
    timeoutMs: 120000,
  });

  assert.match(command, /-s timeout 30000 -w 120000$/);
});
```

- [ ] **Step 2: Run the AA unit test and verify RED**

Run:

```bash
node --import tsx --test harmonyos-ohostest-runner/tests/ohostest.test.ts
```

Expected: FAIL because the explicit timeout is ignored.

- [ ] **Step 3: Make the command builder configurable**

Add `testCaseTimeoutMs?: number` to `BuildAaTestCommandInput` and render:

```typescript
"-s timeout",
String(input.testCaseTimeoutMs ?? AA_TEST_CASE_TIMEOUT_MS),
```

Run the same test file. Expected: PASS, including the existing default-15000 assertions.

- [ ] **Step 4: Write failing matrix and case propagation tests**

In `config.test.ts`, call:

```typescript
const config = await loadMatrixConfig({
  project,
  machineConfigPath,
  testCaseTimeoutMs: 30000,
});
assert.equal(config.testCaseTimeoutMs, 30000);
```

Also assert a normal call yields `AA_TEST_CASE_TIMEOUT_MS`.

In the standard `case-runner.test.ts` metadata fixture add:

```typescript
test_case_timeout_ms: 30000,
```

After the case run assert:

```typescript
assert.match(commands.join("\n"), /-s timeout 30000 -w 120000/);
assert.equal(result.metadata.testCaseTimeoutMs, 30000);
```

- [ ] **Step 5: Run propagation tests and verify RED**

Run:

```bash
node --import tsx --test \
  harmonyos-ohostest-runner/tests/config.test.ts \
  harmonyos-ohostest-runner/tests/case-runner.test.ts
```

Expected: FAIL because matrix input/config and case result do not carry the new value.

- [ ] **Step 6: Implement explicit propagation**

Add `testCaseTimeoutMs?: number` to `LoadMatrixConfigInput` and `RunMatrixInput`; add required `testCaseTimeoutMs: number` to `MatrixConfig`. Set:

```typescript
testCaseTimeoutMs:
  input.input.testCaseTimeoutMs ?? AA_TEST_CASE_TIMEOUT_MS,
```

Pass it in `createMatrixRunContext()`:

```typescript
testCaseTimeoutMs: input.testCaseTimeoutMs,
```

Pass it in `buildTestCommand()`:

```typescript
testCaseTimeoutMs: config.testCaseTimeoutMs,
```

Pass case metadata in `runCaseMatrix()`:

```typescript
testCaseTimeoutMs: context.metadata.testCaseTimeoutMs,
```

Extend case result metadata:

```typescript
metadata: {
  testCaseTimeoutMs: number;
}
```

and return it from `metadataForResult()`:

```typescript
testCaseTimeoutMs: metadata.testCaseTimeoutMs,
```

- [ ] **Step 7: Run propagation tests and verify GREEN**

Run:

```bash
node --import tsx --test \
  harmonyos-ohostest-runner/tests/ohostest.test.ts \
  harmonyos-ohostest-runner/tests/config.test.ts \
  harmonyos-ohostest-runner/tests/case-config.test.ts \
  harmonyos-ohostest-runner/tests/case-runner.test.ts
```

Expected: all tests PASS.

- [ ] **Step 8: Commit timeout propagation**

```bash
git add harmonyos-ohostest-runner/src/matrix/ohostest.ts \
  harmonyos-ohostest-runner/src/matrix/config.ts \
  harmonyos-ohostest-runner/src/matrix/types/index.ts \
  harmonyos-ohostest-runner/src/matrix/runner.ts \
  harmonyos-ohostest-runner/src/case/runner.ts \
  harmonyos-ohostest-runner/src/case/result.ts \
  harmonyos-ohostest-runner/src/case/types/index.ts \
  harmonyos-ohostest-runner/tests/ohostest.test.ts \
  harmonyos-ohostest-runner/tests/config.test.ts \
  harmonyos-ohostest-runner/tests/case-runner.test.ts
git commit -m "feat: apply case test timeout"
```

### Task 4: Document and Configure the Real Case

**Files:**
- Modify: `harmonyos-ohostest-runner/docs/usage/matrix.md`
- Modify: `harmonyos-ohostest-runner/docs/usage/case.md`
- Modify: `ResponsiveRepeatLayout/case/metadata.json`

- [ ] **Step 1: Update the real metadata**

Add at the top level:

```json
"test_case_timeout_ms": 30000,
```

- [ ] **Step 2: Update case documentation**

Add a field-table row:

```markdown
| `test_case_timeout_ms` | 可选。单个测试用例超时，单位毫秒，必须为正整数；默认 15000 |
```

Show `test_case_timeout_ms: 30000` in the metadata example and explain that it overrides `AA_TEST_CASE_TIMEOUT_MS` only for case mode.

- [ ] **Step 3: Update matrix discovery documentation**

Replace entry-specific wording with:

```markdown
- `build-profile.json5`：product 名称和模块列表
- 各模块 `hvigorfile.ts`：通过 `hapTasks` 识别 HAP 模块
- `<hap-srcPath>/src/ohosTest/module.json5`：ohosTest module 名称
```

State that automatic discovery currently requires exactly one product-applicable HAP module and reports an error for zero or multiple matches.

- [ ] **Step 4: Verify formatting and commit docs/config**

Run:

```bash
node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync("ResponsiveRepeatLayout/case/metadata.json","utf8"));'
git diff --check
```

Expected: both commands exit 0.

Commit:

```bash
git add harmonyos-ohostest-runner/docs/usage/matrix.md \
  harmonyos-ohostest-runner/docs/usage/case.md \
  ResponsiveRepeatLayout/case/metadata.json
git commit -m "docs: configure case test timeout"
```

### Task 5: Full Verification and Real-Project Validation

**Files:**
- Verify only; fix only files already in scope if a check exposes a defect.

- [ ] **Step 1: Run the complete unit test suite**

Run:

```bash
npm --prefix harmonyos-ohostest-runner test
```

Expected: exit 0 with zero failed tests.

- [ ] **Step 2: Run lint**

Run:

```bash
npm --prefix harmonyos-ohostest-runner run lint
```

Expected: exit 0 with no ESLint errors.

- [ ] **Step 3: Run the TypeScript build**

Run:

```bash
npm --prefix harmonyos-ohostest-runner run build
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 4: Verify real-project discovery without mutating devices**

Run a focused configuration-load command against `ResponsiveRepeatLayout/case/task` and the existing runner machine config:

```bash
node --import tsx --input-type=module -e '
  import { loadCaseMetadata } from "./harmonyos-ohostest-runner/src/case/config.ts";
  import { loadMatrixConfig } from "./harmonyos-ohostest-runner/src/matrix/config.ts";
  const metadata = await loadCaseMetadata("ResponsiveRepeatLayout/case");
  const config = await loadMatrixConfig({
    project: metadata.baseProject,
    machineConfigPath: "harmonyos-ohostest-runner/config/machine.json",
    testCaseTimeoutMs: metadata.testCaseTimeoutMs,
  });
  console.log(JSON.stringify({
    module: config.module,
    moduleSrcPath: config.moduleSrcPath,
    testCaseTimeoutMs: config.testCaseTimeoutMs,
  }, null, 2));
'
```

Expected:

```json
{
  "module": "entry",
  "moduleSrcPath": "products/entry",
  "testCaseTimeoutMs": 30000
}
```

Check configured targets with the `hdc` path from `machine.json`. If the required target is connected, run:

```bash
npm --prefix harmonyos-ohostest-runner run ohostest:case -- \
  --case ../ResponsiveRepeatLayout/case \
  --machine-config config/machine.json \
  --run answer
```

Open the emitted result path's sibling `commands.log` and verify it contains:

```text
-s timeout 30000
```

If no target is available, report the environment limitation separately; configuration discovery, build, unit tests, lint, and TypeScript build remain mandatory.

- [ ] **Step 5: Inspect final scope**

Run:

```bash
git status --short
git diff HEAD~4 --stat
git log -5 --oneline
```

Expected: the pre-existing user change to `harmonyos-ohostest-runner/config/machine.json` remains untouched; no unrelated files are modified.
