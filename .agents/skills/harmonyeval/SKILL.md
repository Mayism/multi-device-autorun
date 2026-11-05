---
name: harmonyeval
description: "在 HarmonyEval 仓库新增或修改评测场景、task YAML、用例集适配器、验证流程和评分规则时使用。指导复用现有能力、通过注册接口扩展及验证架构边界，适用于一多、迁移、MCP 对照和 HTTP 问答等场景的开发与审查。"
---

# HarmonyEval 评测扩展规范

让各场景复用同一条评测流水线：加载用例 → 执行被测对象 → 验证并留存证据 → 计算分数 → 聚合报告。

## 开始工作

定位仓库根目录；当前参考实现包含 `pyproject.toml` 和 `harmonyeval/api/`，以下源码路径均相对于根目录。若任务是把另一个旧仓库重构成此结构，先按主指南盘点旧入口，不要求目标已经存在 harmonyeval/。先检查工作区已有改动，保留其他场景的工作。

所有修改同时遵循根目录 `AGENTS.md` 的 Windows 兼容要求：文本文件显式指定 UTF-8，外部工具输出按实际协议解码，处理 GBK 终端不能表示的字符，并检查 Windows 路径、命令和进程行为。涉及这些逻辑时读取架构参考中的验证要求；不要把 macOS/Linux 上运行成功当作 Windows 实测。

根据任务读取相应参考：

- 配置场景或新增用例集：读 [用例集与任务配置](references/datasets.md)。
- 新增验证器、组合流程或评分器：读 [验证与评分](references/verification-and-scoring.md)。
- 调整公共能力、审查变更或准备交付：读 [架构边界与自验证](references/architecture.md)。

以当前 `harmonyeval/api/{contracts,interfaces,registry}.py` 和具体适配器的实现、schema 为准。发现文档与代码不符时，先核实差异；不要把尚未实现的方案描述为可用功能。docs 按用途维护三份文档：`docs/harmony-eval-framework-design.md` 说明架构、重构步骤和扩展开发；`docs/harmony-eval-task-examples.md` 说明运行方式、字段枚举、对照配置和15份 YAML；`docs/harmony-eval-adapter-implementation.md` 按当前源码详解用例到 EvalScope Sample 的转换、Agent 与 Skill/Plugin/MCP 执行及对照、验证与评分适配，以及完整扩展示例。

迁移其他仓库时，不能用本参考仓库的 static_eval 实现覆盖目标已有静态评测的不同判据。先核实其实际输入、调用时机、执行次数、评分与报告，再保留迁移；任务级评价不能自动变成逐用例评价。当前 static_eval 是独立并行分支，核心编排在 evaluator/coordinator.py，包调用在 static_eval/；每批一次，不混入 verification/scoring。

## 选择最小扩展点

| 实际需求 | 实施位置 |
|---|---|
| 换模型、Agent、Skill、Plugin、MCP、提示词或用例路径 | task YAML、OpenCode 配置、用例文件 |
| 新组合已有验收步骤 | `verification` 条目或 `Workflow` |
| 执行已有验收命令或独立评价 Skill | `Command` 或 `SkillVerifier`，先确认其结果协议适合需求 |
| 新数据格式 | 用例集适配器，注册到 `harmonyeval.datasets` |
| 新验收工具、证据解析或业务指标 | 验证器，注册到 `harmonyeval.verification` |
| 内置取值、布尔判断、加权扣分无法表达的计算 | 评分器，注册到 `harmonyeval.scoring` |
| 新被测对象接入方式或执行协议 | 先核实能否复用 target/engine；必要时扩展对应注册接口 |

普通场景优先使用配置或独立 Python 扩展包。确需修改公共框架时，把能力实现为各场景可复用的接口，并验证已有场景；不要在 CLI、主调度、报告中增加按 `scenario` 名称分支的流水线。

## 必须保持的边界

1. `evaluator/` 对接 EvalScope 的完整生命周期；`verification/` 是业务验证流程。各场景共用 `DefaultEvaluator`，不要复制一套场景专用调度器。
2. `benchmarks/` 加载、准备、指纹化用例；公开输入交给 Agent，标准答案、golden/test patch 和评分资料留在评估侧。目录副本不是操作系统访问沙箱。
3. `agent/` 只负责执行被测任务；`verification/` 执行验证并产出证据；`metrics/` 只读取结构化结果做确定性计算。评分器不得启动测试、请求模型或重新生成工程。
4. 验证副本使用系统临时目录，持久证据写入本流程 `verification/<id>/`；保护 Agent 的 `base/`，不得让多个用例共享可写工程目录。
5. `type` 选择实现，`verification.id` 标识实例并供 `depends_on`/`source` 引用，`dimension` 标识评分项。不得靠名称猜实现或给固定场景硬编码报告列。
6. 保留已有协议和状态语义。业务失败与证据不可用分别表达；缺失证据不能变成零分或满分。变更 adapter/判据时维护 `version` 和缓存身份。
7. 被测 OpenCode Plugin/Skill 与框架 Python 扩展是两种注册。Plugin 名不是必然可用的 Agent ID；MCP 对照通过 OpenCode 配置或 experiments 控制，不使用 HTTP 问答的 `knowledge` 字段冒充 MCP。

benchmark 是包含用例、任务输入和评价方法的完整评测基准。当前所有场景共用 EvalScope 的 `harmony_eval` benchmark；本框架的 dataset/verification/scoring entry points 是它内部的业务扩展层，不要求逐场景注册 EvalScope benchmark。当前 YAML 未开放任意 benchmark 选择字段。详细接入和开发交付要求分别见重构指南第 7、8 节。

## 交付要求

提交可审查的任务配置、用例格式说明、验证指标/证据协议、评分引用关系及必要测试。注明哪些只完成离线验证，哪些实际调用过 Agent、模型或设备。

运行与修改相关的检查，至少核对 YAML 可加载、扩展可发现、正常/失败/缺失证据的行为；涉及框架依赖时运行架构测试。具体命令见架构参考。`--check` 不代表真实评测成功。

若尚缺业务判据，保留为待确认项；不要用 API 数量相等、编译通过或 Agent 自述代替尚未定义的功能正确性。遇到口径变化，先更新证据与评分协议，再同步配置和文档。
