import fs from "node:fs";
import path from "node:path";

function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function batchQuote(value) {
  if (/["\r\n\0]/.test(value)) throw new Error("CLI 启动路径包含 Windows 批处理不支持的字符");
  return `"${value.replace(/%/g, "%%")}"`;
}

function windowsEntrypoint(command, fileSystem) {
  if (!command.toLowerCase().endsWith(".cmd")) return null;
  const source = fileSystem.readFileSync(command, "utf8");
  // 仅识别 npm 的标准 shim；不能把任意 .cmd 当 JS，或绕过自定义脚本。
  if (!/SET "_prog=|IF EXIST "%~dp0[\\/]node\.exe"/i.test(source) || !source.includes("%*")) return null;
  const targets = [...source.matchAll(/"(?:%dp0%|%~dp0)[\\/]*([^"%\r\n]+\.[cm]?js)"/gi)];
  const candidates = new Set(targets.map((match) => path.win32.resolve(path.win32.dirname(command), match[1])));
  if (candidates.size !== 1) return null;
  const entrypoint = fileSystem.realpathSync([...candidates][0]);
  if (!fileSystem.statSync(entrypoint).isFile()) return null;
  const packageRoot = /^(.*[\\/]@deveco[\\/]deveco-cli)[\\/]/i.exec(entrypoint)?.[1];
  if (!packageRoot) return null;
  const manifest = JSON.parse(fileSystem.readFileSync(path.win32.join(packageRoot, "package.json"), "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.devecocli;
  if (manifest.name !== "@deveco/deveco-cli" || typeof bin !== "string") return null;
  const declared = fileSystem.realpathSync(path.win32.resolve(packageRoot, bin));
  if (declared.toLowerCase() !== entrypoint.toLowerCase()) return null;
  return { entrypoint, ...(manifest.engines?.node ? { requiredNode: String(manifest.engines.node) } : {}) };
}

// npm 的 Node CLI 可能被 DevEco 的旧 Node 抢占。固定 CLI 的解释器，
// 不改变 Hvigor/ohpm 使用的 PATH。fileSystem 用于跨平台入口解析测试。
export function createPinnedDevEcoCli({
  pathValue, nodePath, binDir, platform = process.platform,
  pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD", fileSystem = fs,
}) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const extensions = windows ? pathExt.split(";").filter(Boolean) : [""];
  for (const rawDirectory of pathValue.split(paths.delimiter)) {
    const directory = windows ? rawDirectory.replace(/^"(.*)"$/, "$1") : rawDirectory;
    if (!directory) continue;
    let command;
    for (const extension of extensions) {
      const candidate = paths.resolve(directory, `devecocli${extension.toLowerCase()}`);
      try {
        fileSystem.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
        if (fileSystem.statSync(candidate).isFile()) { command = candidate; break; }
      } catch { /* 继续遵循 PATH/PATHEXT 查找下一个可执行文件。 */ }
    }
    if (!command) continue;
    let entrypoint;
    let requiredNode;
    try {
      if (windows) {
        const resolved = windowsEntrypoint(command, fileSystem);
        if (!resolved) return null;
        ({ entrypoint, requiredNode } = resolved);
      } else {
        entrypoint = fileSystem.realpathSync(command);
        const fd = fileSystem.openSync(entrypoint, "r");
        const header = Buffer.alloc(512);
        let firstLine;
        try {
          const length = fileSystem.readSync(fd, header, 0, header.length, 0);
          firstLine = header.subarray(0, length).toString("utf8").split("\n")[0];
        } finally {
          fileSystem.closeSync(fd);
        }
        if (!/^#!\s*(?:\/usr\/bin\/env\s+node|\/[^\r\n]*\/node)[ \t]*\r?$/.test(firstLine)) return null;
      }
    } catch (error) {
      throw new Error(`无法解析 PATH 中的 devecocli 入口 ${command}: ${error.message}`, { cause: error });
    }
    fileSystem.mkdirSync(binDir, { recursive: true });
    const shellWrapper = paths.join(binDir, "devecocli");
    // Windows 的无扩展名入口供 Git Bash 使用；cmd/PowerShell 使用 .cmd。
    const shellNode = windows ? nodePath.replace(/\\/g, "/") : nodePath;
    const shellEntry = windows ? entrypoint.replace(/\\/g, "/") : entrypoint;
    fileSystem.writeFileSync(shellWrapper, `#!/bin/sh\nexec ${shellQuote(shellNode)} ${shellQuote(shellEntry)} "$@"\n`, { mode: 0o755 });
    fileSystem.chmodSync(shellWrapper, 0o755);
    const wrapper = windows ? `${shellWrapper}.cmd` : shellWrapper;
    if (windows) {
      fileSystem.writeFileSync(wrapper, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${batchQuote(nodePath)} ${batchQuote(entrypoint)} %*\r\nexit /b %errorlevel%\r\n`);
    }
    return { binDir, command: wrapper, entrypoint, nodePath, ...(requiredNode ? { requiredNode } : {}) };
  }
  return null;
}
