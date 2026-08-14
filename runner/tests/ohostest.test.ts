import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAaTestCommand,
  parseAaTestOutput,
  shellQuote,
} from "../src/execution/ohostest.js";

test("buildAaTestCommand emits full module command without class filter", () => {
  const command = buildAaTestCommand({
    hdc: "/fake/hdc",
    target: "127.0.0.1:15001",
    bundleName: "zhsc.1.xxxxxx",
    testModule: "entry_test",
    testRunner: "OpenHarmonyTestRunner",
    timeoutMs: 120000,
  });

  assert.equal(
    command,
    "/fake/hdc -t 127.0.0.1:15001 shell aa test -b zhsc.1.xxxxxx -m entry_test -s unittest OpenHarmonyTestRunner -s timeout 15000 -w 120000",
  );
});

test("buildAaTestCommand includes class filter when configured", () => {
  const command = buildAaTestCommand({
    hdc: "/fake/hdc",
    target: "127.0.0.1:15002",
    bundleName: "zhsc.1.xxxxxx",
    testModule: "entry_test",
    testRunner: "OpenHarmonyTestRunner",
    timeoutMs: 120000,
    testClass: "HomePageAdaptiveTest",
  });

  assert.match(command, /-s class HomePageAdaptiveTest/);
  assert.match(command, /-s timeout 15000/);
});

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

test("parseAaTestOutput extracts summary and report code", () => {
  const parsed = parseAaTestOutput(
    [
      "OHOS_REPORT_RESULT: stream=Tests run: 25, Failure: 0, Error: 0, Pass: 25, Ignore: 0",
      "OHOS_REPORT_CODE: 0",
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    ok: true,
    testsRun: 25,
    failures: 0,
    errors: 0,
    passes: 25,
    ignored: 0,
    testCases: [],
    reportCode: 0,
  });
});

test("parseAaTestOutput extracts each test case status from OHOS status records", () => {
  const parsed = parseAaTestOutput(
    [
      "OHOS_REPORT_STATUS: class=MdFailToPassTest",
      "OHOS_REPORT_STATUS: test=should_fail_on_md_layout",
      "OHOS_REPORT_STATUS_CODE: 1",
      "OHOS_REPORT_STATUS: class=MdFailToPassTest",
      "OHOS_REPORT_STATUS: stack=    at AssertException @ohos/hypium (service.js:23:9)",
      "    at should_fail_on_md_layout (MdFailToPass.test.ets:42:7)",
      "OHOS_REPORT_STATUS: stream=Error in should_fail_on_md_layout, expect true, actualValue is false",
      "OHOS_REPORT_STATUS: test=should_fail_on_md_layout",
      "OHOS_REPORT_STATUS_CODE: -2",
      "OHOS_REPORT_STATUS: consuming=239",
      "OHOS_REPORT_STATUS: class=MdFailToPassTest",
      "OHOS_REPORT_STATUS: test=should_pass_common_quality",
      "OHOS_REPORT_STATUS_CODE: 1",
      "OHOS_REPORT_STATUS: class=MdFailToPassTest",
      "OHOS_REPORT_STATUS: test=should_pass_common_quality",
      "OHOS_REPORT_STATUS_CODE: 0",
      "OHOS_REPORT_RESULT: stream=Tests run: 2, Failure: 1, Error: 0, Pass: 1, Ignore: 0",
      "OHOS_REPORT_CODE: -1",
    ].join("\n"),
  );

  assert.deepEqual(parsed.testCases, [
    {
      name: "should_fail_on_md_layout",
      status: "failed",
      statusCode: -2,
      durationMs: 239,
      message:
        "Error in should_fail_on_md_layout, expect true, actualValue is false",
      stack:
        "at AssertException @ohos/hypium (service.js:23:9)\n    at should_fail_on_md_layout (MdFailToPass.test.ets:42:7)",
    },
    {
      name: "should_pass_common_quality",
      status: "passed",
      statusCode: 0,
    },
  ]);
});

test("parseAaTestOutput marks missing summary as unparseable", () => {
  const parsed = parseAaTestOutput("runner exited without summary");

  assert.deepEqual(parsed, {
    ok: false,
    blockedReason: "test_output_unparseable",
  });
});

test("shellQuote uses Windows-compatible double quotes for paths with spaces", () => {
  assert.equal(
    shellQuote("D:\\Software\\Deveco Studio\\emulator\\deployed", "win32"),
    '"D:\\Software\\Deveco Studio\\emulator\\deployed"',
  );
  assert.equal(shellQuote("Mate 80 Pro", "win32"), '"Mate 80 Pro"');
});
