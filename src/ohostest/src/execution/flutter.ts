import path from "node:path";
import { shellQuote } from "./utils/shellQuote.js";
import type { BuildCommand, ExecutionConfig } from "./types/index.js";

// Flutter（flutter_flutter ohos 分支）工程：Flutter 根目录 + ohos/ 壳工程。
// 每轮在补丁应用后执行 flutter pub get：golden_patch 可能新增 Dart 依赖，
// .dart_tool 必须在 hvigor 内 flutter assemble 前刷新；Dart 编译、引擎 HAR
// 与 flutter_assets 注入由 flutter-hvigor-plugin 在 hvigor 构建内完成，
// 构建命令序列与 native 保持一致。
export function flutterPrepareCommands(config: ExecutionConfig): BuildCommand[] {
  const root = config.flutter?.root;
  if (!root) {
    throw new Error(
      "case_flutter_root_missing: ExecutionConfig.flutter is required",
    );
  }
  return [{ command: `${shellQuote(flutterBin(config))} pub get`, cwd: root }];
}

// paths.flutter 指向 SDK 根目录（含 bin/flutter）；未配置时回退 PATH 上的 flutter。
function flutterBin(config: ExecutionConfig): string {
  const configured = config.paths.flutter?.trim();
  if (!configured) return "flutter";
  return path.join(
    configured,
    "bin",
    process.platform === "win32" ? "flutter.bat" : "flutter",
  );
}
