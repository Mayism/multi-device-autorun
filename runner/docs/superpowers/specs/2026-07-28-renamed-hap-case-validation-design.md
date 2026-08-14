# Renamed HAP Case Validation Design

## Goal

Rename the real `ResponsiveRepeatLayout/case` HAP module so neither its module name nor source path contains `entry`, then validate the runner through its real `ohostest:case` mode.

## Rename Contract

The case baseline project changes as follows:

- Module name: `entry` to `phone`
- Module source directory: `products/entry` to `products/phone`
- ohosTest module name: `entry_test` to `phone_test`
- HarmonyOS module type remains `entry`

The rename must be applied consistently to:

- `case/task/build-profile.json5`
- `case/task/products/phone/src/main/module.json5`
- `case/task/products/phone/oh-package.json5`
- `case/test_patch.patch`
- `case/golden_patch.patch`
- `case/metadata.json`

All patch file headers and paths must use `products/phone`. The test patch must create `phone_test` as the ohosTest module.

## Validation

Before running the case, apply the same synthesis order used by the runner in a temporary copy:

1. Copy the renamed baseline project.
2. Verify and apply `test_patch.patch`.
3. Verify and apply `golden_patch.patch`.

Then run:

```bash
npm run ohostest:case -- \
  --case ../ResponsiveRepeatLayout/case \
  --machine-config config/machine.json \
  --run answer \
  --device phone \
  --keep-emulators false
```

The validation succeeds only when:

- Case status is `completed`.
- Build status is `passed`.
- The phone device passes all 11 selected tests with zero failures and errors.
- The command log contains `module=phone@ohosTest`.
- HAP paths contain `phone-default-unsigned.hap` and `phone-ohosTest-unsigned.hap`.
- AA commands contain `-m phone_test` and `-s timeout 30000`.
- The runner starts and stops the configured phone emulator.

## Git State

Perform the rename on `main` alongside the already squashed, uncommitted runner changes. Do not create a commit. Preserve the existing unstaged `harmonyos-ohostest-runner/config/machine.json` modification.
