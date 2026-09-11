# Whitebox Evaluation

Autorun 的独立 HarmonyOS 白盒评价子系统。它读取本地 Prompt、修改前的 `original`、修改后的最终 `base` 和 Patch。Patch 只用于确定本次变更的文件与行范围，实际代码证据始终读取 `base`；随后执行任务理解、静态规则、规则裁判、Rubric 裁判与分数融合，并输出结构化 JSON 和单文件 HTML。

## 安装与构建

依赖统一维护在仓库根目录。请在仓库根目录执行：

```bash
npm install
```

白盒评价需要先编译为 `src/whitebox/dist/localCli.js` 才能运行。根目录 `npm install` 会通过 `postinstall` 自动构建；源码修改后可执行 `npm run build:whitebox`。

正式运行由仓库根目录的 `autorun.mjs` 调度。单独调试：

```bash
npm run whitebox:evaluate -- --input D:/out/<batch>/<case>/whitebox/inputs/input.json --port 62400
```

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
