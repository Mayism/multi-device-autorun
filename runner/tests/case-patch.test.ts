import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  applyPatch,
  buildGitApplyCommand,
  copyBaseProject,
} from "../src/case/patch.js";

test("copyBaseProject copies symlink targets as real files and directories", async (t) => {
  const root = path.join(process.cwd(), ".tmp-copy-base-project-test");
  const baseProject = path.join(root, "base");
  const workProject = path.join(root, "work", "project");
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(baseProject, "actual-dir"), { recursive: true });
  await fs.writeFile(
    path.join(baseProject, "actual-file.txt"),
    "file target\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(baseProject, "actual-dir", "nested.txt"),
    "directory target\n",
    "utf-8",
  );
  await fs.symlink("actual-file.txt", path.join(baseProject, "file-link.txt"));
  await fs.symlink("actual-dir", path.join(baseProject, "dir-link"), "dir");

  await copyBaseProject({ baseProject, workProject });

  const copiedFileLink = await fs.lstat(
    path.join(workProject, "file-link.txt"),
  );
  const copiedDirLink = await fs.lstat(path.join(workProject, "dir-link"));
  assert.equal(copiedFileLink.isSymbolicLink(), false);
  assert.equal(copiedFileLink.isFile(), true);
  assert.equal(copiedDirLink.isSymbolicLink(), false);
  assert.equal(copiedDirLink.isDirectory(), true);
  assert.equal(
    await fs.readFile(path.join(workProject, "file-link.txt"), "utf-8"),
    "file target\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(workProject, "dir-link", "nested.txt"),
      "utf-8",
    ),
    "directory target\n",
  );
});

test("copyBaseProject honors project gitignore rules", async (t) => {
  const root = path.join(process.cwd(), ".tmp-copy-gitignore-test");
  const baseProject = path.join(root, "base");
  const workProject = path.join(root, "work", "project");
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(baseProject, "build"), { recursive: true });
  await fs.mkdir(path.join(baseProject, "logs"), { recursive: true });
  await fs.mkdir(path.join(baseProject, "module"), { recursive: true });
  await fs.writeFile(
    path.join(baseProject, ".gitignore"),
    ["build/", "*.log", "!logs/keep.log", "/root-only.txt", ""].join("\n"),
  );
  await fs.writeFile(path.join(baseProject, "source.txt"), "source\n");
  await fs.writeFile(path.join(baseProject, "build", "output.bin"), "build\n");
  await fs.writeFile(path.join(baseProject, "logs", "drop.log"), "drop\n");
  await fs.writeFile(path.join(baseProject, "logs", "keep.log"), "keep\n");
  await fs.writeFile(path.join(baseProject, "root-only.txt"), "root\n");
  await fs.writeFile(
    path.join(baseProject, "module", "root-only.txt"),
    "nested\n",
  );

  await copyBaseProject({ baseProject, workProject });

  assert.equal(
    await fs.readFile(path.join(workProject, "source.txt"), "utf-8"),
    "source\n",
  );
  assert.equal(
    await fs.readFile(path.join(workProject, "logs", "keep.log"), "utf-8"),
    "keep\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(workProject, "module", "root-only.txt"),
      "utf-8",
    ),
    "nested\n",
  );
  assert.equal(
    await fs.readFile(path.join(workProject, ".gitignore"), "utf-8"),
    "build/\n*.log\n!logs/keep.log\n/root-only.txt\n",
  );
  await assert.rejects(fs.stat(path.join(workProject, "build")));
  await assert.rejects(fs.stat(path.join(workProject, "logs", "drop.log")));
  await assert.rejects(fs.stat(path.join(workProject, "root-only.txt")));
});

test("copyBaseProject honors nested gitignore rules", async (t) => {
  const root = path.join(process.cwd(), ".tmp-copy-nested-gitignore-test");
  const baseProject = path.join(root, "base");
  const workProject = path.join(root, "work", "project");
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(baseProject, "module"), { recursive: true });
  await fs.writeFile(path.join(baseProject, ".gitignore"), "*.tmp\n");
  await fs.writeFile(
    path.join(baseProject, "module", ".gitignore"),
    "!keep.tmp\n/local.txt\n",
  );
  await fs.writeFile(path.join(baseProject, "module", "keep.tmp"), "keep\n");
  await fs.writeFile(path.join(baseProject, "module", "drop.tmp"), "drop\n");
  await fs.writeFile(path.join(baseProject, "module", "local.txt"), "local\n");

  await copyBaseProject({ baseProject, workProject });

  assert.equal(
    await fs.readFile(path.join(workProject, "module", "keep.tmp"), "utf-8"),
    "keep\n",
  );
  assert.equal(
    await fs.readFile(path.join(workProject, "module", ".gitignore"), "utf-8"),
    "!keep.tmp\n/local.txt\n",
  );
  await assert.rejects(fs.stat(path.join(workProject, "module", "drop.tmp")));
  await assert.rejects(fs.stat(path.join(workProject, "module", "local.txt")));
});

test("applyPatch applies relative to project even when project is inside a parent git repository", async (t) => {
  const root = path.join(process.cwd(), ".tmp-case-patch-test");
  const project = path.join(root, "project");
  const patchFile = path.join(root, "add-file.patch");
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "existing.txt"), "base\n", "utf-8");
  await fs.writeFile(
    patchFile,
    [
      "diff --git a/generated.txt b/generated.txt",
      "new file mode 100644",
      "index 0000000..1269488",
      "--- /dev/null",
      "+++ b/generated.txt",
      "@@ -0,0 +1 @@",
      "+generated",
      "",
    ].join("\n"),
    "utf-8",
  );

  await applyPatch({ project, patchFile, label: "test_patch" });

  assert.equal(
    await fs.readFile(path.join(project, "generated.txt"), "utf-8"),
    "generated\n",
  );
  await assert.rejects(fs.stat(path.join(process.cwd(), "generated.txt")));
});

test("buildGitApplyCommand uses cmd-compatible environment syntax on Windows", () => {
  const command = buildGitApplyCommand({
    project: "C:\\work\\case\\project",
    patchFile: "C:\\work\\case\\golden patch.patch",
    check: true,
    platform: "win32",
  });

  assert.equal(
    command,
    'set "GIT_CEILING_DIRECTORIES=C:\\work\\case" && git apply --ignore-whitespace --check "C:\\work\\case\\golden patch.patch"',
  );
});

test("buildGitApplyCommand keeps inline environment syntax on POSIX shells", () => {
  const command = buildGitApplyCommand({
    project: "/tmp/case/project",
    patchFile: "/tmp/case/golden patch.patch",
    check: false,
    platform: "darwin",
  });

  assert.equal(
    command,
    "GIT_CEILING_DIRECTORIES=/tmp/case git apply --ignore-whitespace '/tmp/case/golden patch.patch'",
  );
});
