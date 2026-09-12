import fs from "node:fs/promises";
import path from "node:path";

export async function resolveNpmCli(): Promise<string> {
  const nodeDir = path.dirname(await fs.realpath(process.execPath));
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, "node_modules/npm/bin/npm-cli.js"),
    path.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    path.resolve(nodeDir, "../share/nodejs/npm/bin/npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      path.basename(candidate) === "npm-cli.js" &&
      (await fs.stat(candidate).catch(() => undefined))?.isFile()
    )
      return candidate;
  }
  throw new Error(
    "web_npm_not_found: run the Runner through npm, or install npm alongside the current Node runtime",
  );
}

export async function validateWebProject(project: string): Promise<void> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(project, "package.json"), "utf-8"),
  ) as { scripts?: { dev?: unknown } };
  if (
    typeof manifest.scripts?.dev !== "string" ||
    !manifest.scripts.dev.trim()
  ) {
    throw new Error("web_dev_script_missing: package.json scripts.dev");
  }
}

export async function resolveNpmInstallCommand(
  project: string,
): Promise<"ci" | "install"> {
  const hasLock = await Promise.all(
    ["package-lock.json", "npm-shrinkwrap.json"].map(async (file) =>
      (
        await fs.stat(path.join(project, file)).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return undefined;
        })
      )?.isFile(),
    ),
  );
  return hasLock.some(Boolean) ? "ci" : "install";
}

export async function webEnvironment(
  outDir: string,
): Promise<NodeJS.ProcessEnv> {
  const cache = path.join(outDir, "web", "npm-cache");
  const temp = path.join(outDir, "web", "tmp");
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(temp, { recursive: true });
  return {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    npm_config_cache: cache,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
  };
}
