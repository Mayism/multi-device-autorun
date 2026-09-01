#!/usr/bin/env node
/**
 * 独立部署 FoldTrigger.ets 到目标 HarmonyOS 工程。
 *
 * 用法：
 *   node --import tsx scripts/deployFoldTrigger.ts --project /path/to/project
 *   node --import tsx scripts/deployFoldTrigger.ts --project /path/to/project --port 8765
 *   node --import tsx scripts/deployFoldTrigger.ts --project /path/to/project --module products/entry
 */
import { deployFoldTrigger } from "../src/fold/server.js";

interface Args {
  project: string;
  port: number;
  module: string;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`参数 ${arg} 缺少取值。`);
    }
    values.set(arg, value);
    i += 1;
  }
  const project = values.get("--project");
  if (!project) {
    throw new Error("缺少必填参数 --project。\n用法: deployFoldTrigger --project /path/to/project [--port 8765] [--module entry]");
  }
  return {
    project,
    port: Number(values.get("--port") ?? 8765),
    module: values.get("--module") ?? "entry",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const deployed = await deployFoldTrigger(args.project, args.port, args.module);
  console.log(`✓ FoldTrigger.ets 已部署到: ${deployed}`);
  console.log(`  端口: ${args.port}`);
  console.log(`  模块: ${args.module}`);
  console.log("");
  console.log("测试用例中导入:");
  console.log("  import { triggerFold, triggerRotation, triggerLandscapeHover, sleep } from '../util/FoldTrigger';");
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
