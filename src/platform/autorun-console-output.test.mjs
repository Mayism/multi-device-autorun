import assert from "node:assert/strict";
import test from "node:test";
import {
  formatEnvironmentCheck,
  formatRunConfiguration,
  writeAutorunStartupSummary,
} from "./autorun-console-output.mjs";
import { ConsoleReporter } from "../runtime/console-reporter.mjs";

test("environment check prints only the result when every check passes", () => {
  assert.equal(formatEnvironmentCheck([]), "环境检查：通过");
});

test("environment check lists compact unique failures", () => {
  assert.equal(
    formatEnvironmentCheck([
      "DevEco CLI：不可用",
      "DevEco   CLI：不可用",
      "HarmonyBot：Skill 未加载\n请先初始化",
    ]),
    [
      "环境检查：失败",
      "- DevEco CLI：不可用",
      "- HarmonyBot：Skill 未加载 请先初始化",
    ].join("\n"),
  );
});

test("run configuration has the same fields for every agent source", () => {
  assert.equal(
    formatRunConfiguration({
      agent: "harmonyos-multi-device",
      providerId: "deepseek",
      modelId: "deepseek-v4",
    }),
    "运行配置：Agent=harmonyos-multi-device；模型=deepseek/deepseek-v4",
  );
  assert.equal(
    formatRunConfiguration({
      agent: "build",
      providerId: "deepseek",
      modelId: "deepseek-v4",
    }),
    "运行配置：Agent=build；模型=deepseek/deepseek-v4",
  );
});

test("startup summary emits no source-specific detail", () => {
  let output = "";
  writeAutorunStartupSummary(
    {
      failures: [],
      agent: "build",
      providerId: "deepseek",
      modelId: "deepseek-v4",
    },
    (value) => {
      output += value;
    },
  );
  assert.equal(
    output,
    "环境检查：通过\n运行配置：Agent=build；模型=deepseek/deepseek-v4\n",
  );
  assert.doesNotMatch(output, /softwareEngineering|HarmonyBot|server|skill/i);
});

test("non-interactive reporter emits one final dashboard table only", () => {
  const stream = {
    isTTY: false,
    columns: 120,
    output: "",
    write(value) {
      this.output += value;
    },
  };
  const reporter = new ConsoleReporter({
    batchId: "batch-1",
    batchRoot: "/tmp/batch-1",
    concurrency: 1,
    cases: [{ name: "CaseA" }],
    stream,
  });

  reporter.start();
  reporter.caseStarted("CaseA", 1);
  reporter.caseProgress("CaseA", "正在分析");
  assert.equal(stream.output, "");
  reporter.caseFinished({
    case: "CaseA",
    status: "completed",
    agentStatus: "completed",
    elapsedSec: 1,
  });
  reporter.finish();

  assert.match(stream.output, /用例\s+生成状态\s+测试状态/);
  assert.match(stream.output, /CaseA\s+已完成/);
  assert.doesNotMatch(stream.output, /\[batch:|\[case:|完整输出|详细结果/);
  assert.equal(stream.output.match(/用例\s+生成状态/g)?.length, 1);
});

function testDisplayWidth(value) {
  let width = 0;
  for (const char of String(value || "")) {
    const code = char.codePointAt(0);
    const wide = code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

function ttyStream(columns) {
  return {
    isTTY: true,
    columns,
    operations: [],
    write(value) {
      this.operations.push({ type: "write", value: String(value) });
      return true;
    },
    moveCursor(x, y) {
      this.operations.push({ type: "moveCursor", x, y });
      return true;
    },
    cursorTo(x) {
      this.operations.push({ type: "cursorTo", x });
      return true;
    },
    clearScreenDown() {
      this.operations.push({ type: "clearScreenDown" });
      return true;
    },
    clearLine(direction) {
      this.operations.push({ type: "clearLine", direction });
      return true;
    },
  };
}

function writtenText(stream) {
  return stream.operations
    .filter((operation) => operation.type === "write")
    .map((operation) => operation.value)
    .join("");
}

for (const columns of [60, 80, 90, 120]) {
  test(`TTY dashboard is stable at ${columns} columns`, () => {
    const stream = ttyStream(columns);
    const reporter = new ConsoleReporter({
      batchId: `batch-${columns}`,
      batchRoot: "/tmp/batch",
      concurrency: 1,
      cases: [{ name: "ImmersiveHideAvoidArea" }],
      stream,
    });

    reporter.start();
    if (reporter.timer) {
      clearInterval(reporter.timer);
      reporter.timer = null;
    }
    const outputBeforeFinish = writtenText(stream);
    assert.equal(outputBeforeFinish === "", columns < 90);

    for (let index = 0; index < 5; index += 1) {
      reporter.caseProgress("ImmersiveHideAvoidArea", `正在分析第 ${index + 1} 步`);
      reporter.render(true);
    }
    reporter.caseFinished({
      case: "ImmersiveHideAvoidArea",
      status: "completed",
      agentStatus: "completed",
    });
    reporter.finish();
    const once = writtenText(stream);
    reporter.finish();
    assert.equal(writtenText(stream), once, "finish() 必须幂等");
    assert.equal(once.match(/用例\s+生成状态/g)?.length, 1);

    for (const operation of stream.operations) {
      if (operation.type !== "write") continue;
      for (const line of operation.value.split("\n").filter(Boolean)) {
        assert.ok(
          testDisplayWidth(line) < columns,
          `${columns} 列终端输出发生换行：${testDisplayWidth(line)} 列`,
        );
      }
    }
  });
}

test("TTY dashboard stops live repainting after a narrow resize", () => {
  const stream = ttyStream(120);
  const reporter = new ConsoleReporter({
    batchId: "resize",
    batchRoot: "/tmp/resize",
    concurrency: 1,
    cases: [{ name: "CaseA" }],
    stream,
  });
  reporter.start();
  if (reporter.timer) {
    clearInterval(reporter.timer);
    reporter.timer = null;
  }
  assert.equal(writtenText(stream).match(/用例\s+生成状态/g)?.length, 1);

  stream.columns = 80;
  reporter.render(true);
  assert.equal(reporter.mode, "static");
  const afterResize = writtenText(stream);
  reporter.caseProgress("CaseA", "缩放后继续运行");
  reporter.render(true);
  assert.equal(writtenText(stream), afterResize, "缩窄后不应继续动态重画");

  reporter.finish();
  const finalText = writtenText(stream);
  assert.equal(finalText.match(/用例\s+生成状态/g)?.length, 2);
  reporter.finish();
  assert.equal(writtenText(stream), finalText);
});

test("TTY without reliable cursor capabilities or width uses one static table", () => {
  for (const stream of [
    { ...ttyStream(undefined), columns: undefined },
    { isTTY: true, columns: 120, output: "", write(value) { this.output += value; } },
  ]) {
    const reporter = new ConsoleReporter({
      batchId: "limited-terminal",
      batchRoot: "/tmp/limited-terminal",
      concurrency: 1,
      cases: [{ name: "CaseA" }],
      stream,
    });
    assert.equal(reporter.mode, "static");
    reporter.start();
    reporter.caseProgress("CaseA", "运行中");
    reporter.render(true);
    reporter.finish();
    const output = stream.operations ? writtenText(stream) : stream.output;
    assert.equal(output.match(/用例\s+生成状态/g)?.length, 1);
  }
});
