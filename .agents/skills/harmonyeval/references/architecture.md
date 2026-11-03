# 架构边界与自验证

## 目录责任

源码直接放在根目录 `harmonyeval/`；不要恢复旧 `src/`、`pyautorun` 或 JSON 批量执行入口。主命令/包名为 harmonyeval。

| 目录 | 职责 | 场景扩展边界 |
|---|---|---|
| `api` | 数据契约、结构接口、注册表 | 不静态依赖实现层 |
| `config` | YAML 加载、规范化、类型参数校验 | 调用注册接口，不按 scenario 写选择分支 |
| `benchmarks` | 用例集与 EvalScope benchmark 桥接 | 输入准备、评估资料隔离、指纹和归档 |
| `evaluator` | EvalScope 全流程、缓存、重评估 | 共用主生命周期，不复制场景调度器 |
| `agent` | 被测对象、执行引擎、环境与会话 | 产生 ExecutionResult，不判分 |
| `verification` | 验证流程和依赖资源调度 | 产生 VerificationResult，允许使用 integrations |
| `metrics` | 确定性评分、指标聚合 | 消费验证结果，不运行被测任务或验收工具 |
| `models` | EvalScope 模型兼容访问 | 不承载场景编排 |
| `integrations` | UITest、云测试、白盒等工具能力 | 不反向调用 evaluator/verification/benchmarks 来组织全任务 |
| `experiments` | 有控制变量的多组实验 | 复用单组评测流程 |
| `report` | 消费结构化结果生成报告 | 不执行测试，不按特定场景写死列与口径 |
| `utils` | 通用文件、路径、数值等辅助 | 不反向依赖业务模块 |

`evaluator + agent` 等协作完成 EvalScope 层面的评测生命周期；业务 verification 是其中一环。不能因为中文都叫“评估器”就把整个调度复制到 verification 中。

`benchmarks/evalscope.py` 的 HarmonyBenchmarkAdapter 继承 EvalScope DefaultDataAdapter，注册为 harmony_eval。它通过 load_dataset、run_inference、calculate_metrics、aggregate_scores、generate_report 桥接业务适配器。当前 runner 固定选择该 benchmark，不支持 YAML 任意选择 EvalScope 内置或外部 benchmark；dataset.type 与 scenario 都不是 benchmark 注册开关。

现有架构测试检查的禁止依赖：

| 起点 | 不得依赖 |
|---|---|
| api | agent/evaluator/verification/benchmarks/models/metrics/integrations/report |
| utils | api/agent/evaluator/verification/benchmarks/models/metrics/integrations/report/config |
| models | agent/evaluator/verification/benchmarks/integrations/report |
| metrics | agent/evaluator/verification/benchmarks/integrations/report |
| agent | evaluator/verification/benchmarks |
| integrations | evaluator/verification/benchmarks |

不要用延迟、相对或动态 import 绕过边界。当前 `tests/test_architecture.py` 检查显式绝对 import，不能证明所有动态依赖或业务设计均正确；仍需审查变更。必要公共契约放在 api，通过注册或依赖注入连接实现。

## 新场景交付清单

按实际需求完成，不要求每个场景都写新适配器：

1. 确定公开输入、被测能力、预期产物、可观察证据及评分口径；先复用已有类型。
2. 任务 YAML 声明 dataset/target、活动目标块、验证指标到评分 source 的映射。对照任务注明变量；验收工具与被测 Agent 分开。
3. 新格式/新验证/新规则放在相应适配器或独立扩展包；普通扩展不修改主 CLI、DefaultEvaluator、BUILTINS、报告调度或中央类型列表。
4. 提供指标的量纲、有效范围、缺失/失败状态、证据样例。新增自定义路径验证、取消、临时目录和版本处理。
5. 保留既有测试/产物协议；更新相关使用说明。对已有场景的公共影响明确说明和验证。

**需要先澄清的业务问题**：无标准答案时如何判分、数量一致是否足够验收、云端的真实成功条件等。**可以直接完成的实现选择**：已有注册接口、辅助函数、目录布局及可逆配置调整。不要为常规扩展额外设置批准流程。

## 自验证

### Windows 与编码

先遵循根目录 AGENTS.md 的全工程规则。修改文本 I/O 时显式指定编码；修改子进程适配时区分 UTF-8 文件、工具自身的 GBK/GB18030 输出，以及终端可表示的字符范围。新增的编码处理复用通用辅助函数，不能让每个场景分别猜测编码。

对实际涉及的逻辑，验证中文/空格路径、UTF-8 与工具实际支持的 GBK/GB18030 输出、GBK 无法表示的字符和输出重定向。人类可读日志可以安全降级；结构化 JSON/验收报告解码失败应保留证据并标为不可用，不用 errors="ignore" 或损坏内容伪造有效结果。明确区分本机编码模拟和真实 Windows 运行。

复用 `harmonyeval/utils/encoding.py` 的 `python_utf8_environment`、`console_print`、`print_json` 和诊断用 `decode_output`。JSON 控制台输出使用 `print_json`；普通字符降级可能产生 JSON 不支持的转义。已知 UTF-8 结构化协议应严格解码，不能使用诊断回退代替。编码回归测试见 `tests/test_windows_encoding.py`。

### 框架检查

在已安装主框架和扩展的同一 Python 环境中，从仓库根目录运行：

```sh
python -m harmonyeval plan /absolute/path/to/task.yaml
python -m harmonyeval run /absolute/path/to/task.yaml --check
python -m unittest tests.test_architecture -q
```

plan/check 只验证各自负责的配置或能力准备，不证明密钥授权、模型真实响应、MCP 工具被使用、设备用例成功。检查可能准备运行环境；真实调用范围按当前任务授权和运行成本决定，不因写 Skill 自动触发云测试。

新验证器/评分器测试至少覆盖：

- 真实可用证据得到预期指标与得分；已执行的业务失败得到有效低分。
- 缺报告、坏格式、零条有效验收、来源 unavailable 时不伪造得分。
- 依赖失败、重跑旧报告、并发隔离、取消/超时等实际涉及的风险。
- 扩展安装后新进程能通过 registry.get 加载；YAML source/id 可连接真实结果。

只改配置/文档时选择相应检查，不要求重跑真实设备或全套集成。调整公共框架时，补跑受影响测试；必要时全量离线验证：

```sh
python -m unittest discover -s tests -q
```

利用现成结果检查验证与评分的独立性：

```sh
python -m harmonyeval verify /absolute/path/to/task.yaml --run /absolute/path/to/single-run
python -m harmonyeval rescore /absolute/path/to/task.yaml --run /absolute/path/to/single-run
```

`--run` 指单组运行目录；配置 experiments 时各组位于批次的 experiments/<id>/，不是批次根。verify 重跑验证、rescore 只消费已有指标；两者不应重新调用生成 Agent。交付时写清运行过的命令和结果，不把离线桩验证称作真实适配成功。
