# Renamed HAP Case Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the real case HAP module from `entry` to `phone` and prove the runner discovers and executes it through `ohostest:case`.

**Architecture:** Move the module directory and update only package/module identifiers and repository-relative patch paths; retain HarmonyOS `module.type: "entry"` and the existing `EntryAbility`. Validate patch synthesis before launching the real case runner, then inspect the fresh case result and command log.

**Tech Stack:** HarmonyOS/Hvigor, JSON5, unified diff patches, TypeScript runner, HDC emulator.

---

## File Structure

- Move `ResponsiveRepeatLayout/case/task/products/entry` to `ResponsiveRepeatLayout/case/task/products/phone`.
- Modify `ResponsiveRepeatLayout/case/task/build-profile.json5`: module name and `srcPath`.
- Modify `ResponsiveRepeatLayout/case/task/products/phone/src/main/module.json5`: module name only.
- Modify `ResponsiveRepeatLayout/case/task/products/phone/oh-package.json5`: package name only.
- Modify `ResponsiveRepeatLayout/case/test_patch.patch`: all module paths and the ohosTest module name.
- Modify `ResponsiveRepeatLayout/case/golden_patch.patch`: all module paths.
- Modify `ResponsiveRepeatLayout/case/metadata.json`: all test source paths.

### Task 1: Rename the Real HAP Module

**Files:**
- Move: `ResponsiveRepeatLayout/case/task/products/entry`
- Modify: `ResponsiveRepeatLayout/case/task/build-profile.json5`
- Modify: `ResponsiveRepeatLayout/case/task/products/phone/src/main/module.json5`
- Modify: `ResponsiveRepeatLayout/case/task/products/phone/oh-package.json5`
- Modify: `ResponsiveRepeatLayout/case/test_patch.patch`
- Modify: `ResponsiveRepeatLayout/case/golden_patch.patch`
- Modify: `ResponsiveRepeatLayout/case/metadata.json`

- [ ] **Step 1: Verify the pre-rename guard fails**

Run:

```bash
test ! -d ResponsiveRepeatLayout/case/task/products/entry
```

Expected: exit 1 because the old module directory still exists.

- [ ] **Step 2: Move the module directory**

Run:

```bash
git mv ResponsiveRepeatLayout/case/task/products/entry \
  ResponsiveRepeatLayout/case/task/products/phone
```

- [ ] **Step 3: Update root module registration**

In `ResponsiveRepeatLayout/case/task/build-profile.json5`, change only:

```json
{
  "name": "phone",
  "srcPath": "./products/phone"
}
```

- [ ] **Step 4: Update package and module names**

In `ResponsiveRepeatLayout/case/task/products/phone/oh-package.json5`:

```json
"name": "phone"
```

In `ResponsiveRepeatLayout/case/task/products/phone/src/main/module.json5`:

```json
"name": "phone",
"type": "entry"
```

Keep `EntryAbility`, `entryability`, and every application source symbol unchanged.

- [ ] **Step 5: Rewrite repository-relative case paths**

Mechanically replace every exact `products/entry` occurrence with `products/phone` in:

```text
ResponsiveRepeatLayout/case/test_patch.patch
ResponsiveRepeatLayout/case/golden_patch.patch
ResponsiveRepeatLayout/case/metadata.json
```

In `test_patch.patch`, additionally replace:

```json
"name": "entry_test"
```

with:

```json
"name": "phone_test"
```

- [ ] **Step 6: Verify the rename guard passes**

Run:

```bash
test ! -d ResponsiveRepeatLayout/case/task/products/entry
test -d ResponsiveRepeatLayout/case/task/products/phone
test "$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("ResponsiveRepeatLayout/case/task/build-profile.json5","utf8")); process.stdout.write(p.modules[0].name)')" = phone
test "$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("ResponsiveRepeatLayout/case/task/products/phone/src/main/module.json5","utf8")); process.stdout.write(p.module.name)')" = phone
test "$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("ResponsiveRepeatLayout/case/task/products/phone/oh-package.json5","utf8")); process.stdout.write(p.name)')" = phone
test "$(rg -o 'products/entry' ResponsiveRepeatLayout/case/test_patch.patch ResponsiveRepeatLayout/case/golden_patch.patch ResponsiveRepeatLayout/case/metadata.json | wc -l | tr -d ' ')" = 0
rg -n '"name": "phone_test"' ResponsiveRepeatLayout/case/test_patch.patch
```

Expected: every command exits 0 and the final search prints the new ohosTest module declaration.

### Task 2: Validate Patch Synthesis

**Files:**
- Verify: `ResponsiveRepeatLayout/case/task`
- Verify: `ResponsiveRepeatLayout/case/test_patch.patch`
- Verify: `ResponsiveRepeatLayout/case/golden_patch.patch`

- [ ] **Step 1: Create an isolated baseline copy**

Run:

```bash
test ! -e /private/tmp/renamed-hap-patch-validation-20260728
mkdir /private/tmp/renamed-hap-patch-validation-20260728
cp -R ResponsiveRepeatLayout/case/task \
  /private/tmp/renamed-hap-patch-validation-20260728/project
```

Expected: every command exits 0.

- [ ] **Step 2: Verify and apply the test patch**

Run from the copied project:

```bash
GIT_CEILING_DIRECTORIES=/private/tmp/renamed-hap-patch-validation-20260728 \
  git apply --ignore-whitespace --check \
  /Users/guoyutong/codeRepo/01-mine/harmonyos-ohostest/ResponsiveRepeatLayout/case/test_patch.patch
GIT_CEILING_DIRECTORIES=/private/tmp/renamed-hap-patch-validation-20260728 \
  git apply --ignore-whitespace \
  /Users/guoyutong/codeRepo/01-mine/harmonyos-ohostest/ResponsiveRepeatLayout/case/test_patch.patch
```

Working directory: `/private/tmp/renamed-hap-patch-validation-20260728/project`.

Expected: both commands exit 0.

- [ ] **Step 3: Verify and apply the golden patch**

Run from the same copied project:

```bash
GIT_CEILING_DIRECTORIES=/private/tmp/renamed-hap-patch-validation-20260728 \
  git apply --ignore-whitespace --check \
  /Users/guoyutong/codeRepo/01-mine/harmonyos-ohostest/ResponsiveRepeatLayout/case/golden_patch.patch
GIT_CEILING_DIRECTORIES=/private/tmp/renamed-hap-patch-validation-20260728 \
  git apply --ignore-whitespace \
  /Users/guoyutong/codeRepo/01-mine/harmonyos-ohostest/ResponsiveRepeatLayout/case/golden_patch.patch
```

Working directory: `/private/tmp/renamed-hap-patch-validation-20260728/project`.

Expected: both commands exit 0.

- [ ] **Step 4: Verify the synthesized project identity**

Run:

```bash
test -f /private/tmp/renamed-hap-patch-validation-20260728/project/products/phone/src/ohosTest/module.json5
rg -n '"name": "phone_test"' \
  /private/tmp/renamed-hap-patch-validation-20260728/project/products/phone/src/ohosTest/module.json5
```

Expected: both commands exit 0.

### Task 3: Run the Real Case Mode Validation

**Files:**
- Verify: `harmonyos-ohostest-runner/scripts/runOhosTestCase.ts`
- Output: `/private/tmp/ohostest-renamed-hap-validation-20260728`

- [ ] **Step 1: Run `ohostest:case`**

From `harmonyos-ohostest-runner`, run:

```bash
npm run ohostest:case -- \
  --case ../ResponsiveRepeatLayout/case \
  --machine-config config/machine.json \
  --run answer \
  --device phone \
  --out /private/tmp/ohostest-renamed-hap-validation-20260728 \
  --keep-emulators false
```

Expected: exit 0 and JSON output with `"status": "completed"`.

- [ ] **Step 2: Verify result values**

Run:

```bash
node -e '
  const fs = require("fs");
  const result = JSON.parse(fs.readFileSync(
    "/private/tmp/ohostest-renamed-hap-validation-20260728/result.json",
    "utf8",
  ));
  const answer = result.runs.answer;
  const phone = answer.devices.find((device) => device.id === "phone");
  if (
    result.status !== "completed" ||
    result.metadata.testCaseTimeoutMs !== 30000 ||
    answer.status !== "completed" ||
    answer.build.status !== "passed" ||
    phone.status !== "passed" ||
    phone.testsRun !== 11 ||
    phone.passes !== 11 ||
    phone.failures !== 0 ||
    phone.errors !== 0 ||
    result.diagnostics.length !== 0
  ) process.exit(1);
  console.log("renamed HAP case result verified");
'
```

Expected: exit 0 and `renamed HAP case result verified`.

- [ ] **Step 3: Verify discovered module, artifacts, AA module, and timeout**

Run:

```bash
command_log=/private/tmp/ohostest-renamed-hap-validation-20260728/answer/commands.log
rg -n 'module=phone@ohosTest' "$command_log"
rg -n 'phone-default-unsigned\.hap' "$command_log"
rg -n 'phone-ohosTest-unsigned\.hap' "$command_log"
test "$(rg -c 'shell aa test .* -m phone_test .* -s timeout 30000' "$command_log")" = 2
rg -n 'Emulator -start.*Mate 80 Pro' "$command_log"
rg -n 'Emulator -stop.*Mate 80 Pro' "$command_log"
```

Expected: every command exits 0; exactly two AA commands use `phone_test` and 30000ms.

- [ ] **Step 4: Verify repository state without committing**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: on `main`, all runner and case changes remain uncommitted; the pre-existing `config/machine.json` modification remains present. Do not run `git commit`.
