import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { filterGeneratedArtifactPatch, restoreGeneratedBuildMode } from "./generated-artifact-filter.mjs";

function git(projectDir, args, { input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: projectDir,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    if (input !== undefined) child.stdin.end(input);
    child.on("close", (code) => {
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code !== 0 && !allowFailure) {
        reject(new Error(`git ${args.join(" ")} 执行失败(${code}): ${result.stderr.toString("utf8")}`));
      } else {
        resolve(result);
      }
    });
  });
}

async function omitGeneratedBuildProfileChanges(projectDir, baseline) {
  const changed = await git(projectDir, ["diff", "--cached", "--name-only", "-z", baseline]);
  const paths = changed.stdout.toString("utf8").split("\0").filter((name) => path.posix.basename(name) === "BuildProfile.ets");
  for (const relativePath of paths) {
    const original = await git(projectDir, ["show", `${baseline}:${relativePath}`], { allowFailure: true });
    if (original.code !== 0) continue;
    let current;
    try {
      current = await fs.readFile(path.join(projectDir, relativePath), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const sanitized = restoreGeneratedBuildMode(original.stdout.toString("utf8"), current, relativePath);
    if (sanitized === current) continue;
    const staged = await git(projectDir, ["ls-files", "--stage", "-z", "--", relativePath]);
    const mode = /^(\d{6}) [0-9a-f]+ 0\t/.exec(staged.stdout.toString("utf8"))?.[1];
    if (!mode) throw new Error(`无法读取 ${relativePath} 的 Git 文件模式`);
    const blob = await git(projectDir, ["hash-object", "-w", "--stdin"], { input: sanitized });
    await git(projectDir, ["update-index", "--cacheinfo", `${mode},${blob.stdout.toString("utf8").trim()},${relativePath}`]);
  }
}

export async function generateAgentChangePatch(projectDir, baseline, patchPath) {
  await git(projectDir, ["add", "-A", "--", "."]);
  await omitGeneratedBuildProfileChanges(projectDir, baseline);
  // 读取暂存区的净化版本，而不是工作树中被编译器改写的文件。
  const diff = await git(projectDir, ["diff", "--cached", "--binary", baseline]);
  await fs.mkdir(path.dirname(patchPath), { recursive: true });
  await fs.writeFile(patchPath, filterGeneratedArtifactPatch(diff.stdout.toString("utf8")), "utf8");
}
