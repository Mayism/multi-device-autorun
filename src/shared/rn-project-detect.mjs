import fsp from "node:fs/promises";
import path from "node:path";

// RN（rnoh）工程识别：在工程根与一层模块目录的依赖清单中查找 RN 痕迹。
// RNOH 壳工程通常在 oh-package.json5 声明 @rnoh/react-native-openharmony 或
// @react-native-ohos/*，RN 侧 package.json 声明 react-native。
const RN_MARKER = /react-native|@rnoh/i;
const MANIFEST_CANDIDATES = ["oh-package.json5", "package.json", "hvigor-config.json5"];
const MAX_MANIFEST_BYTES = 512 * 1024;

export async function detectRnProject(projectDir) {
  const root = String(projectDir || "");
  if (!root) return false;
  const candidates = MANIFEST_CANDIDATES.map((name) => path.join(root, name));
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(path.join(root, entry.name, "oh-package.json5"));
    }
  } catch {
    return false;
  }
  for (const candidate of candidates) {
    if (await manifestMatches(candidate)) return true;
  }
  return false;
}

async function manifestMatches(filePath) {
  let content;
  try {
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(MAX_MANIFEST_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
  return RN_MARKER.test(content);
}
