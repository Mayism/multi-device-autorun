import fs from "node:fs/promises";
import path from "node:path";
import { foldTriggerTemplate } from "./foldTriggerTemplate.js";
import { healthCheck } from "./utils/healthCheck.js";

export {
  buildListForwardCommand,
  buildRemoveReversePortCommand,
  buildReversePortCommand,
} from "./forwarding.js";
export {
  readFoldServerState,
  removeFoldServerState,
  writeFoldServerState,
} from "./state.js";
export {
  startManagedFoldServer,
  stopManagedFoldServer,
} from "./resourceManager.js";

/**
 * 将 FoldTrigger.ets 部署到目标 HarmonyOS 工程的 ohosTest 目录。
 * 总是覆盖以确保多设备场景下每个设备获得正确的端口。
 * 返回部署后的文件路径。
 */
export async function deployFoldTrigger(
  projectPath: string,
  devicePort: number,
  moduleSrcPath: string = "entry",
): Promise<string> {
  const targetDir = path.join(
    projectPath,
    moduleSrcPath,
    "src",
    "ohosTest",
    "ets",
    "util",
  );
  const targetFile = path.join(targetDir, "FoldTrigger.ets");

  await fs.mkdir(targetDir, { recursive: true });
  const content = foldTriggerTemplate(devicePort);
  await fs.writeFile(targetFile, content, "utf-8");
  return targetFile;
}

export { healthCheck };
export type { ManagedFoldServerInstance as FoldServerInstance } from "./resourceManager.js";
