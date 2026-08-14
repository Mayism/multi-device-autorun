# HSP Install and Clean Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make matrix and case runs clean the main Hvigor build, discover and validate all applicable HSP artifacts, install them with the app/test HAPs, and stop before `aa test` when HDC reports an install error with exit code zero.

**Architecture:** Project discovery records and dependency-orders product-applicable shared modules without exposing them in reports. `runBuild` returns the unchanged report `BuildResult` plus an internal, validated `InstallArtifacts`; runner passes that internal value into device execution, which installs HSPs one-by-one in dependency order before installing the two HAPs and validates both process status and AppMod output.

**Tech Stack:** TypeScript 6, Node.js `node:test`, filesystem APIs, existing command executor and HarmonyOS Hvigor/HDC tooling.

---

## File Structure

- Modify `src/matrix/utils/projectDiscovery.ts`: discover shared modules and their product output directories.
- Modify `src/matrix/types/index.ts`: define internal shared-module, install-artifact, and build-outcome types.
- Modify `src/matrix/config.ts`: carry discovered shared modules into the internal matrix configuration.
- Create `tests/project-discovery.test.ts`: isolate module type and product filtering behavior.
- Modify `src/matrix/build.ts`: prepend clean, resolve HSP files, and return internal install artifacts.
- Create `tests/build.test.ts`: cover clean ordering, skip-build, signature matching, and missing/ambiguous HSPs.
- Modify `src/matrix/device.ts`: install HSPs and detect AppMod business failures.
- Modify `tests/device.test.ts`: cover package order, quoting, and zero-exit install failures.
- Modify `src/matrix/runner.ts`: thread install artifacts from build to device execution without serializing them.
- Modify `tests/runner.test.ts`: cover the integrated success and early-block paths.
- Modify `docs/usage/matrix.md`, `docs/usage/case.md`, and `CHANGELOG.md`: document clean and HSP behavior.

### Task 1: Discover Product-Applicable Shared Modules

**Files:**
- Create: `harmonyos-ohostest-runner/tests/project-discovery.test.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/utils/projectDiscovery.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/types/index.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/config.ts`
- Modify: `harmonyos-ohostest-runner/tests/config.test.ts`
- Modify: `harmonyos-ohostest-runner/tests/device.test.ts`

- [ ] **Step 1: Write failing discovery tests**

Create temporary projects whose root build profile contains entry, shared, feature, and product-specific shared modules. Assert the wished-for API:

```typescript
const info = await discoverProjectInfo(project);

assert.deepEqual(info.sharedModules, [
  {
    name: "common",
    srcPath: "commons/common",
    outputDir: path.join(
      project,
      "commons/common/build/default/outputs/default",
    ),
  },
]);
```

Add separate tests proving:

```typescript
assert.deepEqual(entryOnlyInfo.sharedModules, []);
assert.deepEqual(otherProductInfo.sharedModules, []);
await assert.rejects(
  discoverProjectInfo(projectWithMissingModuleJson),
  /module common.*module\.json5/i,
);
```

- [ ] **Step 2: Run the discovery test and verify RED**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/project-discovery.test.ts
```

Expected: FAIL because `ProjectInfo.sharedModules` does not exist.

- [ ] **Step 3: Add the internal types and discovery implementation**

Add these non-report types to `src/matrix/types/index.ts`:

```typescript
export interface SharedModuleInfo {
  name: string;
  srcPath: string;
  outputDir: string;
}

export interface InstallArtifacts {
  hspPaths: string[];
  appHap: string;
  testHap: string;
}

export interface BuildOutcome {
  result: BuildResult;
  installArtifacts?: InstallArtifacts;
}
```

Add `sharedModules: SharedModuleInfo[]` to internal `MatrixConfig`. Extend project discovery module parsing:

```typescript
interface ModuleConfig {
  module?: { type?: string };
}

function appliesToProduct(
  moduleInfo: ProjectModuleInfo,
  product: string,
): boolean {
  if (!moduleInfo.targets || moduleInfo.targets.length === 0) {
    return true;
  }
  return moduleInfo.targets.some((target) =>
    target.applyToProducts?.includes(product),
  );
}
```

For each applicable root module, read `<srcPath>/src/main/module.json5`; include only `type === "shared"` and build `outputDir` with the absolute project path. Preserve root module order. Add the discovered array to `ProjectInfo` and propagate it from `loadMatrixConfig()` into `MatrixConfig`.

Update typed test configurations with:

```typescript
sharedModules: [],
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/project-discovery.test.ts tests/config.test.ts tests/device.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 5: Commit shared-module discovery**

```bash
git add harmonyos-ohostest-runner/src/matrix/utils/projectDiscovery.ts \
  harmonyos-ohostest-runner/src/matrix/types/index.ts \
  harmonyos-ohostest-runner/src/matrix/config.ts \
  harmonyos-ohostest-runner/tests/project-discovery.test.ts \
  harmonyos-ohostest-runner/tests/config.test.ts \
  harmonyos-ohostest-runner/tests/device.test.ts
git commit -m "feat: discover shared HarmonyOS modules"
```

### Task 2: Clean Main Builds and Resolve HSP Artifacts

**Files:**
- Create: `harmonyos-ohostest-runner/tests/build.test.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/build.ts`

- [ ] **Step 1: Write failing clean-order tests**

Build a minimal `MatrixConfig` and capture `runBuild()` commands:

```typescript
const outcome = await runBuild({
  config,
  skipBuild: false,
  diagnostics: [],
  runCommand: async (command) => {
    commands.push(command);
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
  },
});

assert.equal(commands[0], "hvigorw clean --no-daemon");
assert.match(commands[1]!, /ohpm install/);
assert.equal(outcome.result.status, "passed");
```

Add a clean failure case asserting that only the clean command ran and
`outcome.result.blockedReason === "build_failed"`.

- [ ] **Step 2: Run the build test and verify RED**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/build.test.ts
```

Expected: FAIL because clean is absent and `runBuild()` returns `BuildResult`, not `BuildOutcome`.

- [ ] **Step 3: Implement clean and BuildOutcome**

Change `runBuild()` to return `Promise<BuildOutcome>`. Prepend:

```typescript
`${shellQuote(config.paths.hvigorw)} clean --no-daemon`
```

to the non-skip command list. Every blocked branch returns:

```typescript
return { result: blockedResult };
```

The passing branch returns the unchanged report result plus:

```typescript
return {
  result: passedResult,
  installArtifacts: {
    hspPaths,
    appHap: input.config.artifacts.appHap,
    testHap: input.config.artifacts.testHap,
  },
};
```

- [ ] **Step 4: Write failing HSP resolution tests**

Extend `tests/build.test.ts` with filesystem-backed shared-module outputs:

```typescript
assert.deepEqual(outcome.installArtifacts?.hspPaths, [
  path.join(commonOutput, "common-default-unsigned.hsp"),
  path.join(stylesOutput, "styles-default-unsigned.hsp"),
]);
assert.equal("hspPaths" in outcome.result, false);
```

Add cases for:

- signed app HAP selecting only `-signed.hsp`;
- `skipBuild: true` producing zero commands but still resolving artifacts;
- missing HSP producing blocked build and a diagnostic containing module/output directory;
- two matching HSP files producing blocked build and listing both candidates;
- HAP-only project producing `hspPaths: []`.

- [ ] **Step 5: Run the build test and verify RED for HSP resolution**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/build.test.ts
```

Expected: the clean tests pass, while HSP tests FAIL because no resolver exists.

- [ ] **Step 6: Implement deterministic HSP resolution**

Implement helpers in `build.ts`:

```typescript
function hspSignatureSuffix(appHap: string): "-unsigned.hsp" | "-signed.hsp" {
  if (appHap.endsWith("-unsigned.hap")) return "-unsigned.hsp";
  if (appHap.endsWith("-signed.hap")) return "-signed.hsp";
  throw new Error(`cannot determine HSP signature type from app HAP: ${appHap}`);
}
```

For every `config.sharedModules` item, read only its `outputDir`, filter regular files by the selected suffix, sort candidates for deterministic diagnostics, and require exactly one. On missing/ambiguous artifacts, append a precise diagnostic and return a blocked result using the existing `hap_missing` reason rather than adding a report field.

- [ ] **Step 7: Run build and configuration tests**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/build.test.ts tests/config.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 8: Commit clean build and artifact resolution**

```bash
git add harmonyos-ohostest-runner/src/matrix/build.ts \
  harmonyos-ohostest-runner/tests/build.test.ts
git commit -m "feat: clean builds and resolve HSP artifacts"
```

### Task 3: Install HSPs and Detect Zero-Exit HDC Failures

**Files:**
- Modify: `harmonyos-ohostest-runner/tests/device.test.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/device.ts`

- [ ] **Step 1: Write failing package-order tests**

Change tests to pass explicit `InstallArtifacts`:

```typescript
await installHaps(context, {
  hspPaths: ["/tmp/common.hsp", "/tmp/styles.hsp"],
  appHap: "/tmp/app.hap",
  testHap: "/tmp/test.hap",
});

assert.deepEqual(commands.slice(1), [
  "hdc -t 127.0.0.1:15001 install -r /tmp/common.hsp",
  "hdc -t 127.0.0.1:15001 install -r /tmp/styles.hsp",
  "hdc -t 127.0.0.1:15001 install -r /tmp/app.hap /tmp/test.hap",
]);
```

Keep a separate empty-HSP test proving the original two-HAP command.

- [ ] **Step 2: Write the failing real-regression output test**

Inject the observed HDC behavior:

```typescript
await assert.rejects(
  installHaps(context, artifactsWithCommon),
  /install_failed/,
);
```

with:

```text
exitCode: 0
stdout: [Info]App install path:... msg:error: failed to install bundle.
code:9568305 error: Failed to install the HAP or HSP because the dependent module does not exist.
entry's dependent module: common does not exist
```

Add equivalent stderr coverage and a normal zero-exit success case.

- [ ] **Step 3: Run device tests and verify RED**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/device.test.ts
```

Expected: FAIL because `installHaps` does not accept artifacts and ignores business errors.

- [ ] **Step 4: Implement package installation and failure detection**

Change the signature to:

```typescript
export async function installHaps(
  ctx: DeviceCommandContext,
  artifacts: InstallArtifacts,
): Promise<void>
```

Build the package list with:

```typescript
for (const hspPath of artifacts.hspPaths) {
  await runInstallCommand(ctx, hdc, [hspPath]);
}
await runInstallCommand(ctx, hdc, [
  artifacts.appHap,
  artifacts.testHap,
]);
```

Add and use:

```typescript
export function isInstallFailure(result: CommandResult): boolean {
  if (result.exitCode !== 0) return true;
  const output = `${result.stdout}\n${result.stderr}`;
  return /msg:error:|error:\s*failed to install|failed to install the HAP or HSP/i.test(
    output,
  );
}
```

Uninstall behavior remains unchanged.

- [ ] **Step 5: Run device tests and verify GREEN**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/device.test.ts
```

Expected: all device tests PASS.

- [ ] **Step 6: Commit device installation behavior**

```bash
git add harmonyos-ohostest-runner/src/matrix/device.ts \
  harmonyos-ohostest-runner/tests/device.test.ts
git commit -m "fix: install HSP dependencies and detect HDC errors"
```

### Task 4: Thread Internal Artifacts Through Matrix Execution

**Files:**
- Modify: `harmonyos-ohostest-runner/tests/runner.test.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/runner.ts`

- [ ] **Step 1: Write a failing integrated HSP success test**

Extend a runner fixture with a `common` shared module and generated HSP. Assert:

```typescript
assert.match(
  commands.join("\n"),
  /install -r .*common-default-unsigned\.hsp .*entry-default-unsigned\.hap .*entry-ohosTest-unsigned\.hap/,
);
assert.equal(result.devices[0]?.status, "passed");
assert.equal("hspPaths" in result.build, false);
```

- [ ] **Step 2: Write a failing early-block test**

Return the real `9568305` stdout for the install command with exit code zero, then assert:

```typescript
assert.equal(result.devices[0]?.status, "blocked");
assert.equal(result.devices[0]?.blockedReason, "install_failed");
assert.equal(commands.some((command) => command.includes("aa test")), false);
```

- [ ] **Step 3: Run runner tests and verify RED**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/runner.test.ts
```

Expected: FAIL because runner still expects a bare `BuildResult` and does not pass install artifacts.

- [ ] **Step 4: Implement the internal artifact flow**

Change the top-level flow to:

```typescript
const buildOutcome = await runBuild(...);
const devices =
  buildOutcome.result.status === "passed" && buildOutcome.installArtifacts
    ? await runSelectedDevices(context, input, buildOutcome.installArtifacts)
    : [];
const result = buildMatrixResult(
  context,
  buildOutcome.result,
  devices,
  deriveMatrixStatus(devices),
);
```

Add `installArtifacts: InstallArtifacts` to `DeviceRunInput`, pass it through
`runSelectedDevices()`, and call:

```typescript
await installHaps(deviceContext, input.installArtifacts);
```

Do not add install artifacts to `MatrixRunContext`, `MatrixResult`, `BuildResult`, summary rendering, or case results.

- [ ] **Step 5: Run focused and full automated tests**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/runner.test.ts tests/device.test.ts tests/build.test.ts
npm test
npm run build
npm run lint
```

Expected: focused tests and the full suite PASS; TypeScript build and lint exit zero.

- [ ] **Step 6: Commit runner integration**

```bash
git add harmonyos-ohostest-runner/src/matrix/runner.ts \
  harmonyos-ohostest-runner/tests/runner.test.ts
git commit -m "fix: pass validated HSP artifacts to devices"
```

### Task 5: Document and Verify the Real Regression

**Files:**
- Modify: `harmonyos-ohostest-runner/docs/usage/matrix.md`
- Modify: `harmonyos-ohostest-runner/docs/usage/case.md`
- Modify: `harmonyos-ohostest-runner/CHANGELOG.md`

- [ ] **Step 1: Document the observable behavior**

Add concise documentation stating:

- main matrix builds start with one `hvigorw clean --no-daemon`;
- skip-build and fold-trigger test-HAP rebuild do not clean;
- applicable shared-module HSPs are auto-discovered and installed before app/test HAPs;
- case SWE and Answer each perform their own clean main build;
- install errors in HDC output block the device before tests.

- [ ] **Step 2: Run documentation and automated verification**

Run:

```bash
cd harmonyos-ohostest-runner
npm test
npm run build
npm run lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 3: Commit documentation**

```bash
git add harmonyos-ohostest-runner/docs/usage/matrix.md \
  harmonyos-ohostest-runner/docs/usage/case.md \
  harmonyos-ohostest-runner/CHANGELOG.md
git commit -m "docs: describe clean HSP-aware runs"
```

- [ ] **Step 4: Execute the real case twice**

Use distinct workspace output directories:

```bash
npm --prefix harmonyos-ohostest-runner run ohostest:case -- \
  --case /Users/guoyutong/temp/case-output-derive-base \
  --run answer \
  --device phone \
  --out /Users/guoyutong/codeRepo/01-mine/harmonyos-ohostest/.case-comparison/2026-07-27-hsp-fixed/run-1

npm --prefix harmonyos-ohostest-runner run ohostest:case -- \
  --case /Users/guoyutong/temp/case-output-derive-base \
  --run answer \
  --device phone \
  --out /Users/guoyutong/codeRepo/01-mine/harmonyos-ohostest/.case-comparison/2026-07-27-hsp-fixed/run-2
```

Expected in both runs:

- clean precedes the main Hvigor builds;
- install includes HSPs before the app/test HAPs;
- no `9568305`, `dependent module does not exist`, or `10104002`;
- `aa test` executes and `SmPassToPass` test cases are parsed;
- device/test statistics match between runs.

- [ ] **Step 5: Perform final branch verification**

Run:

```bash
git status --short
git log --oneline --decorate -6
```

Expected: only the pre-existing user-owned `config/machine.json` modification and generated `.case-comparison/` outputs remain uncommitted; implementation and documentation commits are present on `codex/hsp-install-clean-build`.
