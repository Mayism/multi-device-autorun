# ArkAnalyzer sidecar

此目录保留可选的 ArkAnalyzer TypeScript 侧车及编译配置，与白盒评价的 Python 代码一同放在 `harmonyeval/integrations/whitebox/` 下。规则、评分配置和 OpenCode 提示在 `harmonyeval/integrations/whitebox/resources/`。

## 构建

白盒运行时和 HTTP 服务由 Python 实现。请在仓库根目录安装：

```bash
python3 -m pip install -e '.[whitebox]'
```

开启 `HMOS_ARKANALYZER_ENABLE=true` 时另执行 `npm ci`；该命令只安装 ArkAnalyzer 和 TypeScript 编译依赖，并生成 `harmonyeval/integrations/whitebox/ark_analyzer/dist/rules/arkfacts/cli.js`。

本地白盒评价可单独调试：

```bash
python3 -m harmonyeval.integrations.whitebox.runtime.local --input D:/out/<batch>/<case>/whitebox/inputs/input.json --port 62400
```

远端任务由 `python3 -m harmonyeval.integrations.whitebox.service.api --case-root <dir> --port 3000` 接收；单任务可使用 `python3 -m harmonyeval.integrations.whitebox.service.remote --input <remote-task.json>`。`npm run whitebox:evaluate`、`npm run whitebox:api` 只是对应 Python 命令的快捷入口。

评测任务统一使用 harmonyeval 和 task YAML，旧 JSON 批量配置已移除。Harmony Eval 的 verification.whiteboxeval 读取 rubric_path、模型和证据预算，省略模型时继承 execution.model；当前实现是模型评价，不会自动执行本目录的完整 ArkAnalyzer 流程。

上述独立白盒调试命令仍使用自己的 input.json/remote-task.json 和运行时参数，不读取 task YAML。独立工具中使用的 judge.providerId 必须与其 OpenCode 配置的 Provider 名称一致；不要将该工具协议与 Harmony Eval 的 execution.model 混用。

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
