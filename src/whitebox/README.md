# ArkAnalyzer sidecar

此目录只保留可选的 ArkAnalyzer TypeScript 侧车及编译配置。白盒评价的 Python 代码在 `pyautorun/`；规则、评分配置和 OpenCode 提示在 `pyautorun/whitebox_resources/`。

## 构建

白盒运行时和 HTTP 服务由 Python 实现。请在仓库根目录安装：

```bash
python3 -m pip install -e '.[whitebox]'
```

开启 `HMOS_ARKANALYZER_ENABLE=true` 时另执行 `npm ci`；该命令只安装 ArkAnalyzer 和 TypeScript 编译依赖，并生成 `src/whitebox/dist/rules/arkfacts/cli.js`。

本地白盒评价可单独调试：

```bash
python3 -m pyautorun.whitebox_local --input D:/out/<batch>/<case>/whitebox/inputs/input.json --port 62400
```

远端任务由 `python3 -m pyautorun.whitebox_api --case-root <dir> --port 3000` 接收；单任务可使用 `python3 -m pyautorun.whitebox_remote --input <remote-task.json>`。`npm run whitebox:evaluate`、`npm run whitebox:api` 只是对应 Python 命令的快捷入口。

裁判模型、并发和超时统一配置在根目录 `config/autorun.config.json` 的 `whiteboxEvaluation` 节点。`judge.providerId` 必须与当前 OpenCode `opencode.json` 中的 Provider 名称完全一致；白盒运行时会按名称复制整个 Provider 配置，不再单独配置协议适配器、baseURL 或 API Key。

Autorun 本地评价使用 `agentBuild` 传入生成 Agent 的真实 Hvigor 尝试。结果按尝试顺序保留，最后一次有效编译决定最终状态；未执行编译时记为 `not_run`，不默认为成功。原有 `remoteBuildSuccess` 仅保留给原工程的远端 API 任务兼容，Autorun 不使用该分支。

## 产物

```text
<case>/whitebox/
├── inputs/
│   ├── input.json
│   ├── original-prompt.md
│   └── effective-prompt.md
├── outputs/
│   ├── result.json
│   └── agent-trace.json
├── report.html
└── logs/
```

评分模型只能访问白盒 Sandbox 内经过过滤的 `base` 工程副本、`original`、用于定位范围的 Patch 和元数据。Patch 缺失或为空时，系统会直接比较明确传入的 `originalProjectPath` 与 `generatedProjectPath` 生成差异，不再假定生成工程目录名为 `workspace`。Autorun 不向裁判模型提供隐藏测试 Patch、golden patch、ohosTest 测试名称或生成 Agent 的完整消息记录。
