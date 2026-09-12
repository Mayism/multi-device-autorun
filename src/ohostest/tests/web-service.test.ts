import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { getEventListeners } from "node:events";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { RunnerLogger } from "../src/logging/logger.js";
import { withWebService } from "../src/case/web/service.js";
import {
  startProcess,
  stopProcess,
  waitForExit,
} from "../src/case/web/process.js";
import { assertPortFree, waitForWebReady } from "../src/case/web/readiness.js";
import { validateWebProject } from "../src/case/web/npm.js";
import { webFixture, writeFile } from "./helpers/web-case.js";

test("Web service rejects an occupied port without replacing the existing server or starting native work", async (t) => {
  const f = await webFixture(t);
  const server = net.createServer();
  await new Promise<void>((resolve) =>
    server.listen(f.port, "127.0.0.1", resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const logger = RunnerLogger.create(path.join(f.out, "commands.jsonl"));
  t.after(() => logger.close());
  await assert.rejects(
    withWebService(
      {
        project: f.project,
        outDir: f.out,
        readyUrl: f.url,
        phase: "swe",
        logger,
      },
      async () => assert.fail("must not run"),
    ),
    /web_port_unavailable/,
  );
  assert.ok(server.listening);
  await assert.rejects(fs.access(path.join(f.out, "web/swe/install.log")));
});

test("Web service stops the npm process tree when native work throws or a phase is interrupted", async (t) => {
  for (const interrupt of [false, true]) {
    await t.test(interrupt ? "interruption" : "native failure", async (t) => {
      const f = await webFixture(t);
      const logger = RunnerLogger.create(path.join(f.out, "commands.jsonl"));
      t.after(() => logger.close());
      const controller = new AbortController();
      const listeners = process.listenerCount("SIGINT");
      await assert.rejects(
        withWebService(
          {
            project: f.project,
            outDir: f.out,
            readyUrl: f.url,
            phase: "swe",
            logger,
            signal: controller.signal,
          },
          async () => {
            assert.equal(await (await fetch(f.url)).text(), "swe");
            if (interrupt) controller.abort(new Error("cancel phase"));
            else throw new Error("native test failed");
          },
        ),
        interrupt ? /cancel phase/ : /native test failed/,
      );
      assert.equal(process.listenerCount("SIGINT"), listeners);
      await assertPortFree(f.url);
    });
  }
});

test("Web service detects dev exit, retains logs, and never invokes native work", async (t) => {
  const f = await webFixture(t);
  await writeFile(
    f.project,
    "server.cjs",
    "console.error('dev exploded'); process.exit(23);",
  );
  const logger = RunnerLogger.create(path.join(f.out, "commands.jsonl"));
  t.after(() => logger.close());
  await assert.rejects(
    withWebService(
      {
        project: f.project,
        outDir: f.out,
        readyUrl: f.url,
        phase: "answer",
        logger,
      },
      async () => assert.fail("must not run"),
    ),
    /web_server_exited/,
  );
  assert.match(
    await fs.readFile(path.join(f.out, "web/answer/dev.log"), "utf-8"),
    /dev exploded/,
  );
  await assertPortFree(f.url);
});

test("Web service reports a dev process that dies after readiness during native execution", async (t) => {
  const f = await webFixture(t);
  await writeFile(
    f.project,
    "server.cjs",
    `const http = require('node:http'); http.createServer((req, res) => {
res.end('ok'); if (req.url === '/exit') setTimeout(() => process.exit(29), 20);
}).listen(${f.port}, '127.0.0.1');`,
  );
  const logger = RunnerLogger.create(path.join(f.out, "commands.jsonl"));
  t.after(() => logger.close());
  await assert.rejects(
    withWebService(
      {
        project: f.project,
        outDir: f.out,
        readyUrl: f.url,
        phase: "swe",
        logger,
      },
      async () => {
        await (await fetch(`${f.url}exit`)).text();
        await sleep(500);
      },
    ),
    /web_server_exited/,
  );
  await assertPortFree(f.url);
});

test("HTTP 503 never marks a Web server ready; a timeout still permits owned process cleanup", async (t) => {
  const f = await webFixture(t);
  const owned = startProcess({
    file: process.execPath,
    args: [
      "-e",
      `require('node:http').createServer((req,res)=>{console.log('503 requested');res.writeHead(503);res.end('wait');}).listen(${f.port},'127.0.0.1')`,
    ],
    cwd: f.root,
    log: path.join(f.root, "503.log"),
  });
  t.after(() => stopProcess(owned));
  await assert.rejects(
    waitForWebReady({
      process: owned,
      url: f.url,
      timeoutMs: 1500,
      signal: new AbortController().signal,
    }),
    /web_server_not_ready/,
  );
  assert.match(
    await fs.readFile(path.join(f.root, "503.log"), "utf-8"),
    /503 requested/,
  );
  await stopProcess(owned);
  await assertPortFree(f.url);
});

test("Web validation accepts a missing lockfile but still requires a dev script", async (t) => {
  const f = await webFixture(t);
  await fs.unlink(path.join(f.project, "package-lock.json"));
  await validateWebProject(f.project);
  await writeFile(f.project, "package.json", '{"scripts":{}}');
  await assert.rejects(validateWebProject(f.project), /web_dev_script_missing/);
});

test("Web service uses npm ci with npm-shrinkwrap.json", async (t) => {
  const f = await webFixture(t);
  const lockPath = path.join(f.project, "npm-shrinkwrap.json");
  await fs.rename(path.join(f.project, "package-lock.json"), lockPath);
  const originalLock = await fs.readFile(lockPath, "utf-8");
  const logPath = path.join(f.out, "commands.jsonl");
  const logger = RunnerLogger.create(logPath);
  try {
    await withWebService(
      {
        project: f.project,
        outDir: f.out,
        readyUrl: f.url,
        phase: "swe",
        logger,
      },
      async () => assert.equal(await (await fetch(f.url)).text(), "swe"),
    );
  } finally {
    await logger.close();
  }
  assert.equal(await fs.readFile(lockPath, "utf-8"), originalLock);
  await assert.rejects(fs.access(path.join(f.project, "package-lock.json")));
  assert.match(
    await fs.readFile(logPath, "utf-8"),
    /npm ci --no-audit --no-fund/,
  );
  await assertPortFree(f.url);
});

test("Web service does not fall back to install when npm ci rejects an outdated lockfile", async (t) => {
  const f = await webFixture(t);
  await writeFile(
    f.root,
    "local-dependency/package.json",
    JSON.stringify({ name: "local-dependency", version: "1.0.0" }),
  );
  const manifestPath = path.join(f.project, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  manifest.dependencies = { "local-dependency": "file:../../local-dependency" };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const lockPath = path.join(f.project, "package-lock.json");
  const originalLock = await fs.readFile(lockPath, "utf-8");
  const logPath = path.join(f.out, "commands.jsonl");
  const logger = RunnerLogger.create(logPath);
  try {
    await assert.rejects(
      withWebService(
        {
          project: f.project,
          outDir: f.out,
          readyUrl: f.url,
          phase: "swe",
          logger,
        },
        async () => assert.fail("native work must not run"),
      ),
      /web_install_failed/,
    );
  } finally {
    await logger.close();
  }
  const log = await fs.readFile(logPath, "utf-8");
  assert.match(log, /npm ci --no-audit --no-fund/);
  assert.doesNotMatch(log, /npm install/);
  assert.equal(await fs.readFile(lockPath, "utf-8"), originalLock);
  await assert.rejects(fs.access(path.join(f.out, "web/swe/dev.log")));
});

test("Unlocked Web installs local dependencies and refreshes them in each phase without generating a lock", async (t) => {
  const f = await webFixture(t);
  await fs.unlink(path.join(f.project, "package-lock.json"));
  const manifest = JSON.parse(
    await fs.readFile(path.join(f.project, "package.json"), "utf8"),
  );
  manifest.dependencies = {};
  const logPath = path.join(f.out, "commands.jsonl");
  const logger = RunnerLogger.create(logPath);
  try {
    for (const phase of ["swe", "answer"] as const) {
      const dependency = `${phase}-fixture-dependency`;
      await writeFile(
        f.root,
        `${dependency}/package.json`,
        JSON.stringify({ name: dependency, version: "1.0.0" }),
      );
      manifest.dependencies[dependency] = `file:../../${dependency}`;
      await writeFile(f.project, "package.json", JSON.stringify(manifest));
      await withWebService(
        { project: f.project, outDir: f.out, readyUrl: f.url, phase, logger },
        async () => {
          const installed = JSON.parse(
            await fs.readFile(
              path.join(f.project, "node_modules", dependency, "package.json"),
              "utf8",
            ),
          );
          assert.equal(installed.name, dependency);
          assert.equal(await (await fetch(f.url)).text(), "swe");
        },
      );
      await assert.rejects(
        fs.access(path.join(f.project, "package-lock.json")),
      );
    }
  } finally {
    await logger.close();
  }
  assert.equal(
    (await fs.readFile(logPath, "utf8")).split(
      "npm install --no-audit --no-fund --package-lock=false",
    ).length - 1,
    2,
  );
});

test("npm process wait has no wall-clock deadline and removes its abort listener after completion", async (t) => {
  const f = await webFixture(t);
  const owned = startProcess({
    file: process.execPath,
    args: ["-e", "setTimeout(()=>process.exit(0),300)"],
    cwd: f.root,
    log: path.join(f.root, "long-install.log"),
  });
  t.after(() => stopProcess(owned));
  const realNow = Date.now;
  let elapsed = 0;
  t.mock.method(Date, "now", () => realNow() + elapsed);
  const controller = new AbortController();
  const pending = waitForExit(owned, controller.signal);
  elapsed = 60 * 60 * 1000;
  assert.equal((await pending).code, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("npm ci can be cancelled while an install hook waits, without starting dev or leaking its process tree", async (t) => {
  const f = await webFixture(t);
  const manifestPath = path.join(f.project, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  manifest.scripts.preinstall = "node install.cjs";
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    f.project,
    "install.cjs",
    `require('node:http').createServer((req,res)=>res.end('installing')).listen(${f.port},'127.0.0.1',()=>require('node:fs').writeFileSync('install.started','ready'));`,
  );
  const logger = RunnerLogger.create(path.join(f.out, "commands.jsonl"));
  t.after(() => logger.close());
  const controller = new AbortController();
  const outcome = withWebService(
    {
      project: f.project,
      outDir: f.out,
      readyUrl: f.url,
      phase: "swe",
      logger,
      signal: controller.signal,
    },
    async () => assert.fail("native work must not run"),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    const marker = path.join(f.project, "install.started");
    const deadline = Date.now() + 10000;
    while (
      !(await fs.stat(marker).catch(() => undefined)) &&
      Date.now() < deadline
    )
      await sleep(25);
    assert.ok(
      await fs.stat(marker).catch(() => undefined),
      "install hook did not start",
    );
    controller.abort(new Error("cancel installation"));
    assert.match(String(await outcome), /cancel installation/);
    await assertPortFree(f.url);
    await assert.rejects(fs.access(path.join(f.out, "web/swe/dev.log")));
    assert.ok(await fs.stat(path.join(f.out, "web/swe/install.log")));
  } finally {
    controller.abort();
    await outcome;
  }
});
