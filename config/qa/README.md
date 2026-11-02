# 智能问答与 MCP 对照任务

在仓库根目录执行下列命令。默认沿用已有三方库任务的 glm-5.3 模型设置；提交版本的 MCP 两组使用 ZHIPU_API_KEY 环境变量，本机可以保留未提交的凭据配置。客服默认不调用模型。

## 1. 用例的 JSON 格式

```json
[
  {
    "id": "unique-question-id",
    "question": "问题文本",
    "reference_answer": "标准答案",
    "criteria": ["评分要点一", "评分要点二"],
    "reference_documents": ["references/doc.md"],
    "metadata": {"topic": "可选分类", "reference_date": "2026-11-02"}
  }
]
```

最低业务字段是 id、question、reference_answer。也支持 reference_answers 字符串数组，以表达多个可接受答案；若同时配置单数/复数，两者必须等价，否则报错。criteria 和 reference_documents 给裁判使用，metadata 保存分类、来源日期等信息；被测 Agent/HTTP 请求默认只接收 id 和问题，不接收标准答案。

数据集 type 仍为 text-qa，支持 JSON 数组、`{"cases": [...]}` 包装对象和原 JSONL。dataset.dir 可以直接指定数据文件，或指向只包含问答 JSON/JSONL 的目录。参考文件相对数据文件所在目录；不要把 OpenCode 配置 JSON 和题集混在同一个 dataset.dir 目录中。

**三个任务共用一份题集 `config/qa/data/cases.json`**：MCP 开启、MCP 关闭、智能客服 URL 均使用相同的三个 HarmonyOS 问题、ID、标准答案和参考资料。新增或修改问题只维护这一份文件，不再保留客服专用的密码/物流等演示题。MCP 两组采用语义评分；客服桩的精确匹配仅用于协议和评分链路冒烟，两类分数不直接作为同一口径的质量排名。

## 2. 华为开发者知识 MCP：有/无对照

任务文件：

- huawei-mcp/with/task.yaml：开启目标 MCP。
- huawei-mcp/without/task.yaml：关闭目标 MCP。
- data/cases.json：MCP 两组与智能客服共用三个 HarmonyOS 问题。
- data/references/：各任务共用的人工整理固定评价依据。
- huawei-mcp/rubric.md：两组相同的语义评分规则。

两组均为 target.type=opencode_agent、agent_name=build，不使用 without_enable。唯一有效引擎配置差异为 `mcp.harmonyos_developer_knowledge.enabled`；config_path 分别指向 opencode.with.json/opencode.without.json。其他宿主能力、模型参数、公开问题、裁判和评分保持一致，预检还应核对公共宿主指纹。

[华为官方接入说明](https://developer.huawei.com/consumer/cn/doc/start/hosknowledgemcp-0000002664603963#section1310314718156)给出的服务地址为 `https://connect-api.cloud.huawei.com/api/developerknowledge/mcp`，工具为 searchDocuments 和 getDocumentsById。官方文档示例用 mcpServers/http；这里采用独立 OpenCode 所需的 mcp/remote 配置格式。没有修改本机全局配置或 HarmonyBot Bundle。

题目与参考答案于 2026-11-02 从该官方服务检索并核验，涵盖 XML/GSKV 首选项、V1 @Prop 单向同步、沉浸式布局与系统栏控制。标准答案是摘要，不要求逐字匹配；官方资料变化后应重核参考资料。裁判通过 LLM_judge 按正确性60、覆盖25、依据与边界15评分，最终 answer_quality 为 0～100。ToolUsage 独立记录 configured/enabled/attempted/succeeded，不因未调用 MCP 直接判问答失败，也不把调用次数当成答案质量。

```sh
source /tmp/harmony-eval-venv312/bin/activate
harmonyeval run ./config/qa/huawei-mcp/with/task.yaml --check
harmonyeval run ./config/qa/huawei-mcp/without/task.yaml --check

# 正式运行会调用生成模型、裁判模型，以及开启组的 MCP。
harmonyeval run ./config/qa/huawei-mcp/with/task.yaml
harmonyeval run ./config/qa/huawei-mcp/without/task.yaml

# 用运行日志中实际生成的两个目录替换占位符；差值为 with 减 without。
harmonyeval compare <without_run_dir> <with_run_dir> --output ./output/harmony-eval/huawei-mcp-comparison
```

输出为 output/harmony-eval/huawei-mcp-qa/各运行ID/，通过 task-report.json 的 variant 不能识别 MCP 开关，因为直接 Agent 任务均使用 with 目录名；应查看 execution.capabilities.mcp 中的 enabled 和 usage 指标。

这是自然使用 MCP 的实验，问题未写工具名或强制调用命令。开启组若没有实际调用，只能说明“工具可用情况下的回答”，不能宣称回答使用了 MCP 知识。预检不请求生成模型，不证明裁判必然返回合法 JSON；空返回或接口错误会保留为 unavailable，不补分。

## 3. 智能客服：本地 URL 桩

customer-service/task.yaml 选择 knowledge（HTTP 智能问答），请求 `http://127.0.0.1:18081/answer`，发送 case_id 和 question，从 data.answer 取回答、data.session_id 取会话 ID。dataset.dir 指向公共 `../data/cases.json`，和 MCP 两组使用同一份题集。此处将智能客服设为 HarmonyOS 开发知识客服，便于共用题集；更换真实后端时需确保其业务范围覆盖这些问题。

终端一启动服务：

```sh
python scripts/qa_customer_stub.py --port 18081
```

终端二执行评测：

```sh
source /tmp/harmony-eval-venv312/bin/activate
harmonyeval run ./config/qa/customer-service/task.yaml --check
harmonyeval run ./config/qa/customer-service/task.yaml
```

桩服务使用独立硬编码的三条知识应答，不读取数据集或标准答案文件；修改公共题集不会自动修改桩服务应答。默认使用 ExactMatch+ImmediateValue，得到 answer_correctness；这用于验证 JSON→HTTP→EvalScope→评分→报告链路，**不是证明真实客服 Agent 的质量**。报告位于 output/harmony-eval/customer-service/各运行ID/。

可以用以下模式验证错误确实被记录：

```sh
# 先停止原服务，再启动选定模式。
python scripts/qa_customer_stub.py --mode wrong   # 返回不匹配答案，预期评分 0
python scripts/qa_customer_stub.py --mode empty   # 空答案，预期执行失败、分数 unavailable
python scripts/qa_customer_stub.py --mode error   # HTTP 503，预期执行失败、分数 unavailable
```

默认只监听 127.0.0.1，可用 GET /health 检查；自验证会用临时端口启动服务并在结束后关闭。正常服务需在评测期间保持运行。--check 当前不探测 HTTP URL 的连通性。

## 4. 更换真实客服后端

将 execution.http_url、request、response 改为真实协议，认证可用请求头中的 `${env:AGENT_TOKEN}`；不要在请求中发送 reference_answer。自然语言答案允许多种表述，宜用语义裁判替换精确匹配。例如将活动 knowledge 块中的验证/评分改为：

```yaml
verification:
  - id: answer
    type: LLM_judge
    model:
      api_type: openai_api
      name: glm-5.3
      base_url: https://open.bigmodel.cn/api/coding/paas/v4
      api_key: ZHIPU_API_KEY
      max_tokens: 8192
scoring:
  - dimension: answer_quality
    type: ImmediateValue
    source: answer.metrics.score
```

已有标准答案和 criteria 可供默认裁判使用；需要业务专用 rubric 再添加 prompt_path。该片段是对原有列表的替换，不能追加重复的 answer id。JSON、SSE 和异步轮询均走现有 HTTP 协议适配器，后端内部模型或工具不返回时标为 unknown。
