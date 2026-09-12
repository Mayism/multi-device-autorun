import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadCaseMetadata } from "../src/case/config.js";
import { runOhosTestCase } from "../src/case/runner.js";
import { caseWorkspace, prepareCaseWorkspace } from "../src/case/workspace.js";
import { readPlatformSettings } from "../src/case/platform.js";
import { assertPortFree } from "../src/case/web/readiness.js";
import { WEB_READY_URL } from "../src/case/web/constants.js";
import { webFixture } from "./helpers/web-case.js";
import { WebHdc } from "./helpers/web-hdc.js";

test("platform settings preserve native defaults and recognize web without host configuration", () => {
  assert.deepEqual(readPlatformSettings({}), {});
  assert.deepEqual(readPlatformSettings({ platform: "native" }), {
    platform: "native",
  });
  assert.deepEqual(readPlatformSettings({ platform: "web" }), {
    platform: "web",
  });
  assert.deepEqual(readPlatformSettings({ platform: "rn" }), {
    platform: "rn",
  });
  assert.deepEqual(readPlatformSettings({ platform: "flutter" }), {
    platform: "flutter",
  });
  for (const platform of ["", null, 42])
    assert.throws(
      () => readPlatformSettings({ platform }),
      /case_platform_unsupported/,
    );
});

test("web workspace preserves sibling projects, ignore rules, and protects source/output boundaries", async (t) => {
  const f = await webFixture(t);
  const metadata = await loadCaseMetadata(f.caseDir);
  const layout = caseWorkspace(metadata, f.out);
  await prepareCaseWorkspace(metadata, layout);
  assert.equal(layout.workProject, path.join(f.out, "work/project/base"));
  assert.equal(
    await fs.readFile(path.join(layout.webProject!, "source.txt"), "utf-8"),
    "swe\n",
  );
  await assert.rejects(fs.access(path.join(layout.webProject!, "ignored.txt")));
  assert.throws(
    () =>
      caseWorkspace(
        { ...metadata, baseProject: path.join(f.root, "external") },
        f.out,
      ),
    /case_web_base_invalid/,
  );
  assert.throws(
    () => caseWorkspace({ ...metadata, baseProject: f.caseDir }, f.out),
    /case_web_base_invalid/,
  );
  assert.throws(
    () => caseWorkspace(metadata, path.join(f.caseDir, "base/runs")),
    /overlaps_source/,
  );
  const nestedOutput = caseWorkspace(
    metadata,
    path.join(f.caseDir, ".ohostest-runs/test"),
  );
  await prepareCaseWorkspace(metadata, nestedOutput);
  await assert.rejects(
    fs.access(path.join(nestedOutput.patchRoot, ".ohostest-runs")),
  );
});

for (const hasLock of [true, false]) {
  test(`platform-only web Case uses real root patches and fresh npm services for SWE and Answer, while native execution stays in base (${hasLock ? "locked" : "unlocked"})`, async (t) => {
    const f = await webFixture(t, Number(new URL(WEB_READY_URL).port));
    if (!hasLock) await fs.unlink(path.join(f.project, "package-lock.json"));
    const observed: string[] = [];
    const hdc = new WebHdc();
    const result = await runOhosTestCase({
      caseDir: f.caseDir,
      out: f.out,
      machineConfigPath: f.machine,
      runMode: "all",
      skipBuild: true,
      keepWorkdir: true,
      commandExecutor: async (command, cwd) => {
        if (command.includes("aa test")) {
          assert.equal(hdc.mappings.get(hdc.targets[0]), "tcp:5175");
          assert.equal(cwd, path.join(f.out, "work/project/base"));
          assert.match(
            await fs.readFile(
              path.join(cwd, "entry/src/ohosTest/ets/test/Web.test.ets"),
              "utf-8",
            ),
            /webTest/,
          );
          observed.push(await (await fetch(f.url)).text());
        }
        return hdc.run(command);
      },
    });
    assert.equal(
      result.status,
      "completed",
      JSON.stringify(result.diagnostics),
    );
    assert.deepEqual(observed, ["swe", "answer"]);
    assert.deepEqual(hdc.events, [
      "add:127.0.0.1:15001",
      "test:127.0.0.1:15001",
      "remove:127.0.0.1:15001",
      "add:127.0.0.1:15001",
      "test:127.0.0.1:15001",
      "remove:127.0.0.1:15001",
    ]);
    assert.equal(hdc.mappings.size, 0);
    assert.equal(result.metadata.platform, "web");
    assert.equal(Object.hasOwn(result.metadata, "web"), false);
    assert.equal(result.artifacts.workdir, path.join(f.out, "work/project"));
    assert.ok(result.artifacts.webLogs);
    assert.equal(
      await fs.readFile(path.join(f.project, "source.txt"), "utf-8"),
      "swe\n",
    );
    await assert.rejects(fs.access(path.join(f.project, "node_modules")));
    for (const phase of ["swe", "answer"]) {
      assert.match(
        await fs.readFile(path.join(f.out, "web", phase, "dev.log"), "utf-8"),
        new RegExp(`boot:${phase}`),
      );
      assert.ok(await fs.stat(path.join(f.out, "web", phase, "install.log")));
    }
    const log = await fs.readFile(path.join(f.out, "commands.jsonl"), "utf-8");
    const installCommand = hasLock
      ? "npm ci --no-audit --no-fund"
      : "npm install --no-audit --no-fund --package-lock=false";
    assert.equal(log.split(installCommand).length - 1, 2);
    if (!hasLock) {
      await assert.rejects(
        fs.access(path.join(f.project, "package-lock.json")),
      );
      await assert.rejects(
        fs.access(path.join(f.out, "work/project/web/package-lock.json")),
      );
    }
    await assertPortFree(f.url);
  });
}

test("web Case default Answer cleans its workspace and records npm failure before any device commands", async (t) => {
  const f = await webFixture(t, Number(new URL(WEB_READY_URL).port));
  const manifestPath = path.join(f.project, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  manifest.scripts.preinstall = 'node -e "process.exit(17)"';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  let commands = 0;
  const result = await runOhosTestCase({
    caseDir: f.caseDir,
    out: f.out,
    machineConfigPath: f.machine,
    commandExecutor: async () => {
      commands++;
      throw new Error("Device commands must not run");
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.diagnostics.join("\n"), /web_install_failed/);
  assert.equal(commands, 0);
  await assert.rejects(fs.access(path.join(f.out, "work")));
  assert.ok(await fs.stat(path.join(f.out, "web/answer/install.log")));
  await assertPortFree(f.url);
});
