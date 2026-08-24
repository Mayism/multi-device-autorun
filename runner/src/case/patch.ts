import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import createIgnore, { type Ignore } from "ignore";
import { defaultCommandExecutor } from "../execution/command.js";
import { removeWithRetry } from "../execution/utils/rm.js";
import { shellQuote } from "../execution/utils/shellQuote.js";
import type { CommandExecutor } from "../execution/types/index.js";

export async function copyBaseProject(input: {
  baseProject: string;
  workProject: string;
}): Promise<void> {
  await removeWithRetry(input.workProject);
  await fs.mkdir(path.dirname(input.workProject), { recursive: true });
  await copyProjectEntry(input.baseProject, input.workProject, "", []);
}

interface IgnoreScope {
  relativeRoot: string;
  matcher: Ignore;
}

async function copyProjectEntry(
  source: string,
  destination: string,
  relativePath: string,
  ignoreScopes: readonly IgnoreScope[],
): Promise<void> {
  if (path.basename(source) === ".git") {
    return;
  }

  const sourceStat = await fs.lstat(source);
  const target = sourceStat.isSymbolicLink()
    ? await fs.realpath(source)
    : source;
  const targetStat = await fs.stat(target);
  if (
    path.basename(source) !== ".gitignore" &&
    isIgnored(relativePath, targetStat.isDirectory(), ignoreScopes)
  ) {
    return;
  }

  await copyProjectTarget(
    target,
    destination,
    relativePath,
    ignoreScopes,
    targetStat,
  );
}

async function copyProjectTarget(
  source: string,
  destination: string,
  relativePath: string,
  ignoreScopes: readonly IgnoreScope[],
  stat: Stats,
): Promise<void> {
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const nestedScopes = await addIgnoreScope(
      source,
      relativePath,
      ignoreScopes,
    );
    const entries = await fs.readdir(source);
    for (const entry of entries) {
      await copyProjectEntry(
        path.join(source, entry),
        path.join(destination, entry),
        relativePath ? `${relativePath}/${entry}` : entry,
        nestedScopes,
      );
    }
    return;
  }

  if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    return;
  }

  throw new Error(`copy_base_project_unsupported_entry: ${source}`);
}

async function addIgnoreScope(
  sourceDirectory: string,
  relativeRoot: string,
  ignoreScopes: readonly IgnoreScope[],
): Promise<readonly IgnoreScope[]> {
  const ignoreFile = path.join(sourceDirectory, ".gitignore");
  let patterns: string;
  try {
    patterns = await fs.readFile(ignoreFile, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ignoreScopes;
    }
    throw error;
  }

  return [
    ...ignoreScopes,
    { relativeRoot, matcher: createIgnore().add(patterns) },
  ];
}

function isIgnored(
  relativePath: string,
  isDirectory: boolean,
  ignoreScopes: readonly IgnoreScope[],
): boolean {
  if (!relativePath) {
    return false;
  }

  let ignored = false;
  for (const scope of ignoreScopes) {
    const scopedPath = path.posix.relative(scope.relativeRoot, relativePath);
    if (
      scopedPath === ".." ||
      scopedPath.startsWith("../") ||
      path.posix.isAbsolute(scopedPath)
    ) {
      continue;
    }
    const result = scope.matcher.test(
      isDirectory ? `${scopedPath}/` : scopedPath,
    );
    if (result.ignored) {
      ignored = true;
    } else if (result.unignored) {
      ignored = false;
    }
  }
  return ignored;
}

export async function applyPatch(input: {
  project: string;
  patchFile: string;
  label: string;
  commandExecutor?: CommandExecutor;
}): Promise<void> {
  const executor = input.commandExecutor ?? defaultCommandExecutor;
  const check = await executor(
    buildGitApplyCommand({
      project: input.project,
      patchFile: input.patchFile,
      check: true,
    }),
    input.project,
  );
  if (check.exitCode !== 0) {
    throw new Error(`patch_apply_failed: ${input.label}`);
  }
  const apply = await executor(
    buildGitApplyCommand({
      project: input.project,
      patchFile: input.patchFile,
      check: false,
    }),
    input.project,
  );
  if (apply.exitCode !== 0) {
    throw new Error(`patch_apply_failed: ${input.label}`);
  }
}

export function buildGitApplyCommand(input: {
  project: string;
  patchFile: string;
  check: boolean;
  platform?: NodeJS.Platform;
}): string {
  const platform = input.platform ?? process.platform;
  const quotedPatch = shellQuote(input.patchFile, platform);
  const checkArg = input.check ? " --check" : "";
  const gitApply = `git apply --ignore-whitespace${checkArg} ${quotedPatch}`;
  const ceiling =
    platform === "win32"
      ? path.win32.dirname(input.project)
      : path.dirname(input.project);

  if (platform === "win32") {
    return `set "GIT_CEILING_DIRECTORIES=${ceiling}" && ${gitApply}`;
  }

  return `GIT_CEILING_DIRECTORIES=${shellQuote(ceiling, platform)} ${gitApply}`;
}
