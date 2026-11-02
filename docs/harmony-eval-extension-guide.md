# 新增评估验证器和评分器

适用于当前 develop 的 Harmony Eval v2。以三方库转换为例，新增验证器和评分器可以放在独立 Python 扩展包中，通过 entry points 安装注册，无需修改主框架的调度、CLI、报告或中央类型列表。

接入新场景前先读 [harmonyeval 开发 Skill](../.agents/skills/harmonyeval/SKILL.md) 和[重构指南的验收与交付要求](harmony-eval-framework-design.md#8-怎样验收和交付)。本指南注册的是本框架的业务适配器，各场景共用 harmony_eval 这个 EvalScope benchmark，不要求每增加一个验证器或场景就注册新的 EvalScope benchmark；两层关系见[重构指南的 EvalScope 接入说明](harmony-eval-framework-design.md#7-怎样接入-evalscope)。

## 1. 先选择需要扩展的层

| 需求 | 做法 | 是否新增 Python 类 |
|---|---|---|
| 已有命令的退出码即可判断通过 | verification 使用内置 Command，评分用 BooleanScoring | 否 |
| 重组现有验证流程 | verification 使用 Workflow 的 steps/workflow_path | 否 |
| 已有指标只需取值、按比例换算或加权 | 使用 ImmediateValue、BooleanScoring、WeightedSummation | 否 |
| 执行新的验收工具、解析新格式、产生新指标 | 新增验证器 | 是 |
| 分段扣分、关键功能额外扣分等内置规则无法表达 | 新增评分器 | 是 |

验证器负责产生可复核事实，如总验收项数、通过项数、关键失败数及证据。评分器读取这些结果做确定性计算；不要在评分器里再次编译、请求模型或运行测试。一个验证器可以对应多个评分维度，多个验证器也可共同供一个评分器使用。

## 2. 自行创建扩展包并注册

需要扩展时，自行在任意目录创建以下项目；本文只提供指南，不附带安装包或模板代码目录：

```text
my-library-eval/
  pyproject.toml
  harmonyeval_library_demo/
    __init__.py
    counts.py
    verifiers.py             # LibraryAcceptance
    scorers.py               # AcceptanceDeduction
```

下文代码用于说明验收工具适配和评分接口，**不包含真实三方库的功能判据或验收程序**。开发时还需提供实际验收脚本，使其完成必要的构建/接口/行为检查，按第 4 节协议输出证据。

自行创建扩展包的 pyproject.toml，注册名称指向下文的 Python 类：

```toml
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "my-library-eval"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["harmonyeval>=0.3.0"]

[project.entry-points."harmonyeval.verification"]
ExampleLibraryAcceptance = "harmonyeval_library_demo.verifiers:LibraryAcceptance"

[project.entry-points."harmonyeval.scoring"]
ExampleAcceptanceDeduction = "harmonyeval_library_demo.scorers:AcceptanceDeduction"

[tool.setuptools.packages.find]
where = ["."]
include = ["harmonyeval_library_demo*"]
```

左侧名称就是任务 YAML 的 type，右侧指向可导入的类。命名应避免与内置类和其他扩展重复。独立包中的类**不要再添加 @verifiers.register/@scorers.register 装饰器**，框架加载 entry point 时已经注册，再注册会报重名。

安装到运行 harmonyeval 的同一个 Python 环境：

```sh
source /tmp/harmony-eval-venv312/bin/activate
# 先按本文完成自己的扩展包，再替换为它的实际目录。
python -m pip install --no-deps -e /absolute/path/to/my-library-eval

# 使用新 Python 进程检查两个类型是否能被发现，无需模型和设备。
python -c "from harmonyeval.api import verifiers, scorers; print(verifiers.get('ExampleLibraryAcceptance')); print(scorers.get('ExampleAcceptanceDeduction'))"
```

这个环境应已安装主框架及 `.[eval]` 依赖；其他机器可使用自己建立的虚拟环境。仅复制 Python 文件到磁盘不会自动注册；安装后启动新的 harmonyeval 命令，entry points 会被自动发现。扩展可以维护在独立仓库并固定包版本，无需放入主框架仓库。

## 3. 验证器接口

自行实现 verifiers.py，例如：

```python
"""Adapt a user-provided acceptance tool to Harmony Eval's workflow contract."""
import json

from harmonyeval.api.contracts import VerificationResult
from harmonyeval.utils.paths import inside
from harmonyeval.verification.base import Workflow
from harmonyeval.verification.context import command_run, isolated_project

from .counts import acceptance_counts


class LibraryAcceptance(Workflow):
    version = '1'
    schema = {
        'type': 'object', 'required': ['command'],
        'properties': {
            'command': {'type': 'array', 'minItems': 1, 'items': {'type': 'string'}},
            'report_file': {'type': 'string', 'minLength': 1},
            'timeout': {'type': 'integer', 'minimum': 1},
        },
    }

    async def verify(self, case, execution, dependencies, context, config):
        # Build/install/test inside this copy; do not mutate the agent's base/.
        project = await isolated_project(execution, context)
        report = inside(context['output'], config.get('report_file', 'acceptance.json'))
        # Re-verify must not accept an old report left by a previous invocation.
        report.unlink(missing_ok=True)
        outcome = await command_run(config['command'], project, context,
                                    'acceptance', config.get('timeout', 600))
        evidence = [outcome]
        if not report.is_file():
            return VerificationResult(config['id'], 'unavailable', version=self.version,
                                      error='验收工具未生成报告', evidence=evidence)
        evidence.append(str(report))
        if outcome['exit_code'] not in (0, 1):
            return VerificationResult(config['id'], 'unavailable', version=self.version,
                                      error='验收工具基础设施错误', evidence=evidence)
        counts = acceptance_counts(json.loads(report.read_text(encoding='utf-8')))
        all_passed = counts['passed'] == counts['total']
        if (outcome['exit_code'] == 0) != all_passed:
            raise ValueError('验收工具退出码与报告的通过状态不一致')
        return VerificationResult(
            config['id'], 'completed', version=self.version,
            metrics={**counts, 'passed_all': all_passed,
                     'pass_rate': counts['passed'] / counts['total']},
            evidence=evidence,
        )
```

上例读取验收工具实际生成的报告，并检查退出码和计数是否一致。acceptance_counts 的实现示例见第 4 节；这些类需要自行创建并安装后才能在 YAML 中引用。

| 参数/方法 | 实际含义 |
|---|---|
| case | EvalCase，包含 case_id、question、root、project、expected、metadata；可在评估阶段读取验收专用资料 |
| execution.project | Agent 生成的目标工程；普通迁移任务是本用例 base/ |
| execution.workspace | Agent 的工作目录；Web 组合工程可能与 project 不同 |
| dependencies | depends_on 声明的前置流程结果字典，内容已转为 dict |
| context.output | 此流程的持久证据目录，即 verification/本流程id/ |
| context.env | 已合并工具链的进程环境 |
| context.temporary_projects | 登记需在流程结束清理的临时工程；isolated_project 会自动登记 |
| config | 本 verification 条目的规范化配置 |
| requirements(config) | 返回资源名称列表；继承 Workflow 默认读取 resources，用于同一进程内互斥 |

尽量复用 isolated_project 和 command_run：前者保护 Agent 原产物，后者处理进程取消、超时、进程树清理，并保存命令 stdout/stderr。外部命令是参数数组，只支持 `${project}` 和 `${output}` 替换，不是 shell 脚本字符串；需要 shell 特性时显式运行自己的脚本。

框架只自动规范化已支持的路径字段。command 中的验收脚本建议填绝对路径，不能假定其 cwd 是仓库根目录。新增自定义路径参数时，在验证器内基于 context.task.base_dir 解析并校验；不要指望任意字段自动转换成绝对路径。

### 结果状态的约定

- 流程正常结束，即使部分断言失败，也可返回 completed，并用 metrics.passed_all=false、pass_rate 等表达业务结果；下游可以读取指标并给低分。
- 工具缺失、无法启动、报告未生成、JSON 不合法或没有执行任何验收项，返回 unavailable 或抛出异常让框架转换为 unavailable，不能伪造零通过或满分。
- depends_on 只在前置状态为 completed 时继续，不代表前置业务指标全部通过；需要时自行检查 dependencies 中的 metrics。
- 默认 requires_execution=true，Agent 未完成则不运行。专门分析失败过程的验证器可显式设置 false，并自行处理无工程/部分产物。

### 需要转换前快照时

可选实现 `async capture_input(self, case, config)`，返回可 JSON 序列化的数据。框架在 Agent 执行前保存为该流程目录的 input-evidence.json，verify 再读取原快照。不要在 verify 中用已修改的工程冒充转换前基线，也不要把样本状态保存在共享类实例中。旧任务没有该快照时，应提示重新运行生成阶段。

## 4. 设计验收报告协议

用户提供的验收工具应把报告写入 `${output}/acceptance.json`：

```json
{
  "total": 10,
  "passed": 8,
  "critical_failures": 1
}
```

这些数字必须来自实际检查，不是 Agent 自报；本例要求非负整数、total>0、passed<=total，关键失败数不超过失败总数。工具退出码约定为：0=全部通过，1=已执行但存在验收失败，其他退出码=工具或基础设施错误。退出码与报告不一致也视作不可用。

构建、安装和测试由这个验收工具组织，仍是一项完整 verification 流程，无需在任务 YAML 另拆 build 节点。每个断言的详细结果、日志、JUnit 或 API 对照表可另存到 `${output}`；需要体现在统一报告时，将路径追加到 VerificationResult.evidence。

计数校验可在自己的 counts.py 中实现，供验证器和评分器共用：

```python
"""Validate a small acceptance-tool protocol; missing evidence is never a zero."""


def acceptance_counts(raw):
    counts = {}
    for key in ('total', 'passed', 'critical_failures'):
        value = raw[key]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f'{key} 必须是非负整数')
        counts[key] = value
    if counts['total'] == 0:
        raise ValueError('没有执行验收项，不能形成有效评分')
    if counts['passed'] > counts['total']:
        raise ValueError('passed 不能超过 total')
    if counts['critical_failures'] > counts['total'] - counts['passed']:
        raise ValueError('critical_failures 不能超过失败项数')
    return counts
```

## 5. 在当前三方库 YAML 中启用

保留原有 dataset、target、execution，以及 API 数量和白盒流程。在**生效的 plugin_agent 块**中追加：

```yaml
plugin_agent:
  verification:
    # 原有 api、code 条目保留，在下面追加这个条目。
    - id: library_acceptance
      type: ExampleLibraryAcceptance
      timeout: 900
      report_file: acceptance.json
      command:
        - python
        - /absolute/path/to/verify_library.py
        - --project
        - ${project}
        - --report
        - ${output}/acceptance.json
  scoring:
    # 原有 api_count_consistency、L3 保留，追加一个新维度。
    - dimension: library_acceptance
      type: ExampleAcceptanceDeduction
      source: library_acceptance.metrics
      critical_penalty: 20
```

这段是追加片段，不是完整任务；不要在原文件中再建一个同名 plugin_agent 顶层键。`/absolute/path/to/verify_library.py` 是你自己的实际验收程序；本文不实现具体库的业务判据。多个库的验收规则不同时，可通过 case.expected/metadata 读取各自规则，在自定义 verify 中组织命令。

不需要自定义扣分规则时，上述 verification 可以直接配内置评分器：

```yaml
- dimension: library_acceptance
  type: ImmediateValue
  source: library_acceptance.metrics.pass_rate
  scale: 100
```

二者是同一维度的替代方案，不要同时配置同名 dimension。id 是验证流程标识，source 的第一段必须引用已配置的 id，dimension 是最终报告中的评分列名；两者可不同。

## 6. 自定义评分器接口

```python
"""An example deterministic deduction rule over acceptance metrics."""
from harmonyeval.api.contracts import ScoreResult
from harmonyeval.utils.numbers import number
from harmonyeval.metrics.sources import source_value

from .counts import acceptance_counts


class AcceptanceDeduction:
    version = '1'
    schema = {
        'type': 'object', 'required': ['source'],
        'properties': {'source': {'type': 'string'},
                       'critical_penalty': {'type': 'number', 'minimum': 0}},
    }

    def score(self, results, config):
        counts = acceptance_counts(source_value(results, config['source']))
        penalty = number(config.get('critical_penalty', 20))
        if penalty < 0:
            raise ValueError('critical_penalty 不能为负数')
        failed = counts['total'] - counts['passed']
        ordinary_deduction = 100 * failed / counts['total']
        critical_deduction = counts['critical_failures'] * penalty
        return ScoreResult(
            config['dimension'], 'scored',
            round(max(0, 100 - ordinary_deduction - critical_deduction), 6),
            max_score=100, version=self.version,
            breakdown=[{'source': config['source'], **counts,
                        'ordinary_deduction': ordinary_deduction,
                        'critical_deduction': critical_deduction}],
        )
```

上述评分器示例按以下规则计算：

```text
普通扣分 = 100 × (total - passed) / total
关键项额外扣分 = critical_failures × critical_penalty
总分 = max(0, 100 - 普通扣分 - 关键项额外扣分)
```

例如 total=10、passed=8、critical_failures=1、critical_penalty=20，得分为 60。关键失败已经包含在普通失败中，这里再额外扣分是本示例**显式选择的加重规则**；若不希望额外处罚，用内置 ImmediateValue 按通过率给分即可。

source_value 拒绝 unavailable/skipped/error 来源；缺字段、非法数据或缺失证据应抛出 ValueError，框架会把本维度标成 unavailable。实现自己的评分器时必须保证有限数值、范围合法，并在 breakdown 记录计算来源；主框架不会对自定义 ScoreResult 自动补做所有数值范围校验。

## 7. 运行、复评与版本

```sh
harmonyeval run ./config/task.library-plugin.with.yaml --check
harmonyeval run ./config/task.library-plugin.with.yaml

# 验证逻辑新增或改变：复用已有 Agent 工程，重新运行评估。
harmonyeval verify ./config/task.library-plugin.with.yaml --run /absolute/path/to/existing_run

# 只有计分规则变化：复用既有验证指标，不再执行验收工具。
harmonyeval rescore ./config/task.library-plugin.with.yaml --run /absolute/path/to/existing_run
```

执行目标、输入或模型等配置改变后不能直接复用旧生成。新增需要 capture_input 的验证器时，旧运行缺转换前证据，应重新 run。验证器增加后，原有 API/白盒也会随 verify 的完整评估流程重新执行，当前没有仅运行某个 id 的 CLI 参数。

自定义类的 version 会进入对应阶段的指纹。**修改代码、验收脚本或统计口径时主动提升 version**；修改扩展包版本号不会自动替代适配器类 version。自定义 command 脚本内容和任意自定义路径文件目前不会自动哈希；仅修改脚本内容而不改配置/类 version，框架无法据此识别规则已变。rubric_path、prompt_path、workflow_path、skill_path 等已支持的评估文件会参与验证指纹。

结果随主框架统一进入 task-report.json 和 index.html；无需修改报告代码。按上述实现，验收报告与命令日志保存在用例目录的 verification/library_acceptance/，评分中保留扣分明细。

## 8. 发布扩展前的最小自验证

至少覆盖：全部通过、真实失败、验收报告缺失/坏格式、工具异常/超时、指标不可用、旧报告不被误复用，以及安装后的 entry points 能在新进程被发现。对照组应使用相同验证器、评分规则和外部脚本版本。设备互斥资源只能协调同一评测进程，跨进程执行仍需独立协调设备。

当前框架契约见 harmonyeval/api/；验证调度见 harmonyeval/verification/pipeline.py；source_value 位于 harmonyeval/metrics/sources.py，评分器位于 harmonyeval/metrics/rules/。此扩展方式也适用于一多、安卓迁移和问答场景，自定义类通过输入和配置区分业务，不需要增加新的场景分支。
