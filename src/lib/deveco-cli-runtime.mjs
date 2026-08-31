import fs from "node:fs";
import path from "node:path";

function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// npm 的 POSIX bin 使用 /usr/bin/env node，会被 DevEco 的旧 Node 抢占。
// 只为已安装的 Node CLI 固定解释器，不改变 Hvigor/ohpm 使用的 PATH。
// Windows npm .cmd 有自己的解释器解析逻辑，不把它当 JS 交给 Node。
export function createPinnedDevEcoCli({ pathValue, nodePath, binDir, platform = process.platform }) {
  if (platform === "win32") return null;
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const command = path.resolve(directory, "devecocli");
    let entrypoint;
    try {
      fs.accessSync(command, fs.constants.X_OK);
      entrypoint = fs.realpathSync(command);
      if (!fs.statSync(entrypoint).isFile()) continue;
    } catch {
      continue;
    }
    // 尊重 PATH 中第一个命令；不绕过用户的 shell/native wrapper 寻找其他副本。
    const fd = fs.openSync(entrypoint, "r");
    const header = Buffer.alloc(512);
    let firstLine;
    try {
      const length = fs.readSync(fd, header, 0, header.length, 0);
      firstLine = header.subarray(0, length).toString("utf8").split("\n")[0];
    } finally {
      fs.closeSync(fd);
    }
    if (!/^#!\s*(?:\/usr\/bin\/env\s+node|\/[^\r\n]*\/node)[ \t]*\r?$/.test(firstLine)) return null;
    fs.mkdirSync(binDir, { recursive: true });
    const wrapper = path.join(binDir, "devecocli");
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(entrypoint)} "$@"\n`, { mode: 0o755 });
    fs.chmodSync(wrapper, 0o755);
    return { binDir, command: wrapper, entrypoint, nodePath };
  }
  return null;
}
