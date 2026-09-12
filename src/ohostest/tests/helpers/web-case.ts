import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { TestContext } from "node:test";

export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function writeFile(
  root: string,
  relative: string,
  contents: string,
): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

export async function webFixture(
  t: TestContext,
  requestedPort?: number,
): Promise<{
  root: string;
  caseDir: string;
  project: string;
  out: string;
  machine: string;
  port: number;
  url: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-web-case-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const caseDir = path.join(root, "case");
  const project = path.join(caseDir, "web");
  const out = path.join(root, "out");
  const port = requestedPort ?? (await freePort());
  const url = `http://127.0.0.1:${port}/`;
  const manifest = {
    name: "web-case-fixture",
    version: "1.0.0",
    scripts: { dev: "node server.cjs" },
  };
  await writeFile(project, "package.json", JSON.stringify(manifest));
  await writeFile(
    project,
    "package-lock.json",
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: manifest.name, version: manifest.version } },
    }),
  );
  await writeFile(project, "source.txt", "swe\n");
  await writeFile(project, ".gitignore", "node_modules/\nignored.txt\n");
  await writeFile(project, "ignored.txt", "do not copy");
  await writeFile(
    project,
    "server.cjs",
    `const http = require('node:http'); const fs = require('node:fs');
const source = fs.readFileSync('source.txt', 'utf8').trim();
console.log('boot:' + source);
http.createServer((req, res) => { res.end(source); }).listen(${port}, '127.0.0.1');
`,
  );
  await writeFile(
    caseDir,
    "metadata.json",
    JSON.stringify({
      case_id: "web-fixture",
      platform: "web",
      base_project: "base",
      test_patch: "test.patch",
      golden_patch: "golden.patch",
      enabled_devices: ["phone"],
      fail_to_pass: ["web_test"],
    }),
  );
  await writeFile(
    caseDir,
    "test.patch",
    newFilePatch(
      "base/entry/src/ohosTest/module.json5",
      '{"module":{"name":"entry_test"}}',
    ) +
      newFilePatch(
        "base/entry/src/ohosTest/ets/test/Web.test.ets",
        "export const webTest = true;",
      ),
  );
  await writeFile(
    caseDir,
    "golden.patch",
    [
      "diff --git a/web/source.txt b/web/source.txt",
      "--- a/web/source.txt",
      "+++ b/web/source.txt",
      "@@ -1 +1 @@",
      "-swe",
      "+answer",
      "",
    ].join("\n"),
  );
  await nativeFixture(caseDir);
  const machine = path.join(root, "machine.json");
  await fs.writeFile(
    machine,
    JSON.stringify({
      paths: {
        hdc: "fake-hdc",
        hvigorw: "fake-hvigor",
        emulatorBin: "fake-emulator",
        emulatorDeployedDir: "fake-deployed",
      },
      devices: [{ id: "phone", target: "127.0.0.1:15001" }],
    }),
  );
  return { root, caseDir, project, out, machine, port, url };
}

function newFilePatch(file: string, contents: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    "@@ -0,0 +1 @@",
    `+${contents}`,
    "",
  ].join("\n");
}

async function nativeFixture(caseDir: string): Promise<void> {
  await writeFile(
    caseDir,
    "base/AppScope/app.json5",
    '{"app":{"bundleName":"org.example.webfixture"}}',
  );
  await writeFile(
    caseDir,
    "base/build-profile.json5",
    '{"app":{"products":[{"name":"default"}]},"modules":[{"name":"entry","srcPath":"./entry"}]}',
  );
  await writeFile(
    caseDir,
    "base/entry/hvigorfile.ts",
    "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n",
  );
  await writeFile(
    caseDir,
    "base/entry/src/main/module.json5",
    '{"module":{"name":"entry","type":"entry","deviceTypes":["phone"]}}',
  );
  await writeFile(
    caseDir,
    "base/entry/build/default/outputs/default/entry-default-unsigned.hap",
    "",
  );
  await writeFile(
    caseDir,
    "base/entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    "",
  );
}
