import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectRnProject } from "./rn-project-detect.mjs";

async function makeProject(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rn-detect-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return root;
}

test("detects rnoh shell project via root oh-package.json5", async (t) => {
  const root = await makeProject({
    "oh-package.json5": `{
      "dependencies": { "@rnoh/react-native-openharmony": "file:./libs/rnoh/react_native_openharmony.har" }
    }`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await detectRnProject(root), true);
});

test("detects RN project via module-level oh-package.json5", async (t) => {
  const root = await makeProject({
    "oh-package.json5": `{ "dependencies": {} }`,
    "entry/oh-package.json5": `{
      "dependencies": { "@react-native-ohos/hvigor-ohos-plugin": "^0.7.3" }
    }`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await detectRnProject(root), true);
});

test("detects RN project via package.json react-native dependency", async (t) => {
  const root = await makeProject({
    "package.json": `{ "dependencies": { "react-native": "0.72.0" } }`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await detectRnProject(root), true);
});

test("plain ArkTS project is not detected as RN", async (t) => {
  const root = await makeProject({
    "oh-package.json5": `{ "dependencies": { "@ohos/hypium": "1.0.0" } }`,
    "entry/oh-package.json5": `{ "dependencies": { "@ohos/entry": "1.0.0" } }`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await detectRnProject(root), false);
});

test("missing or unreadable project directory is not RN", async () => {
  assert.equal(await detectRnProject(""), false);
  assert.equal(await detectRnProject(path.join(os.tmpdir(), "rn-detect-no-such-dir")), false);
});
