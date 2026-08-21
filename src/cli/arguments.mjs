import process from "node:process";

export function parseArgs(argv) {
  const result = {
    configPath: "./config/autorun.config.json",
    checkOnly: false,
    retryBatchId: "",
    retryCaseName: "",
    merge: undefined,
    cloudTest: false,
    cloudProjectName: "",
    cloudProjectDir: "",
    appPath: "",
    taskName: "",
    pollTask: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config" || value === "-c") {
      if (!argv[index + 1]) throw new Error(`${value} 需要配置文件路径`);
      result.configPath = argv[++index];
    } else if (value === "--check") {
      result.checkOnly = true;
    } else if (value === "--retry") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--retry 需要历史批次 ID");
      result.retryBatchId = argv[++index];
    } else if (value === "--case") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--case 需要用例名称");
      result.retryCaseName = argv[++index];
    } else if (value === "--cloud-test") {
      result.cloudTest = true;
    } else if (value === "--project") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--project 需要工程目录名（base 或 task）");
      result.cloudProjectName = argv[++index];
    } else if (value === "--project-dir") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--project-dir 需要工程目录路径");
      result.cloudProjectDir = argv[++index];
    } else if (value === "--app") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--app 需要 .app 文件路径");
      result.appPath = argv[++index];
    } else if (value === "--task-name") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--task-name 需要任务名称");
      result.taskName = argv[++index];
    } else if (value === "--poll-task") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--poll-task 需要任务组 ID");
      result.pollTask = argv[++index];
    } else if (value === "--merge") {
      // 可选根目录：下一个 token 存在且不是 flag 则当作根目录，否则用 config 的 outputRoot
      if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        result.merge = argv[++index];
      } else {
        result.merge = "";
      }
    } else if (value === "--help" || value === "-h") {
      console.log([
        "用法:",
        "  node autorun.mjs [--config config/autorun.config.json] [--check]",
        "  node autorun.mjs --retry <batchId> [--case <caseName>] [--config config/autorun.config.json]",
        "  node autorun.mjs --merge [output目录] [--config config/autorun.config.json]",
        "  node autorun.mjs --cloud-test (--case <caseName> [--project base|task] | --project-dir <dir> | --app <签名.app>) [--task-name <名称>] [--config config/autorun.config.json]",
        "  node autorun.mjs --poll-task <taskGroupId> [--config config/autorun.config.json]",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${value}`);
    }
  }
  if (result.retryCaseName && !result.retryBatchId && !result.cloudTest) throw new Error("--case 只能和 --retry 或 --cloud-test 一起使用");
  if (result.checkOnly && result.retryBatchId) throw new Error("--check 不能和 --retry 一起使用");
  if (result.merge !== undefined && result.checkOnly) throw new Error("--merge 不能和 --check 一起使用");
  if (result.merge !== undefined && result.retryBatchId) throw new Error("--merge 不能和 --retry 一起使用");
  if (result.cloudTest) {
    if (result.checkOnly) throw new Error("--cloud-test 不能和 --check 一起使用");
    if (result.retryBatchId) throw new Error("--cloud-test 不能和 --retry 一起使用");
    if (result.merge !== undefined) throw new Error("--cloud-test 不能和 --merge 一起使用");
    if (result.pollTask) throw new Error("--cloud-test 不能和 --poll-task 一起使用");
    if (!result.retryCaseName && !result.cloudProjectDir && !result.appPath) {
      throw new Error("--cloud-test 需要 --case <用例名>、--project-dir <工程目录> 或 --app <签名.app 文件> 之一");
    }
    if (result.cloudProjectDir && result.retryCaseName) throw new Error("--project-dir 不能和 --case 一起使用");
  } else if (result.pollTask) {
    if (result.checkOnly) throw new Error("--poll-task 不能和 --check 一起使用");
    if (result.retryBatchId) throw new Error("--poll-task 不能和 --retry 一起使用");
    if (result.merge !== undefined) throw new Error("--poll-task 不能和 --merge 一起使用");
    if (!/^\d+$/.test(result.pollTask)) throw new Error("--poll-task 需要纯数字任务组 ID");
  } else if (result.cloudProjectName || result.cloudProjectDir || result.appPath || result.taskName) {
    throw new Error("--project/--project-dir/--app/--task-name 只能和 --cloud-test 一起使用");
  }
  return result;
}


