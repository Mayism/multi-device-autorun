# Harmony Eval v2 使用说明

入口是 `harmony-eval run ./config/task.yaml`。通用框架直接接入 EvalScope 1.14.x 的 DataAdapter、DefaultEvaluator、预测/评估缓存、SampleScore 和报告生命周期。OpenCode 正式模型请求通过每个样本独立的 EvalScope Model Proxy；HTTP 后端通过 HttpAgentModelAPI 进入同一生命周期。

## 安装与命令

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[eval]'

harmony-eval plan ./config/task.yaml
harmony-eval run ./config/task.yaml --check
harmony-eval run ./config/task.yaml
```

`plan/--check` 解析数据集并检查实际 Agent/Plugin/Skill 装载，不请求生成模型。模型配置的 `api_key` 可填环境变量名，也兼容直接填写包含连字符、点等字符的密钥；合法环境变量名格式的字符串按变量名解析。直接填写的密钥在加载后换成进程内引用，生成的配置快照与报告不包含密钥。白盒评估器省略 model 时复用 execution.model，无需 YAML 锚点；需要独立裁判模型时再显式填写。`static_eval` 仅保留字段，不执行、不计分。所有相对路径以任务 YAML 所在目录为基准。

```sh
harmony-eval verify ./config/task.yaml --run ./output/harmony-eval/<run_id>
harmony-eval rescore ./config/task.yaml --run ./output/harmony-eval/<run_id>
harmony-eval compare <without_run_dir> <with_run_dir> --output ./output/comparison
```

`verify` 使用保存的答案/工程重新评估；`rescore` 只用已有验证指标重新算分。输入、执行配置或能力源变化会拒绝复用；参考资料、评估规则变化要求先 verify。compare 校验输入、模型/执行预算和评分规则，按 case_id+轮次配对，差值为右组减左组，并显示两组完成数、失败数和配对覆盖。

## thirdcase 的插件对照

已准备：

- `config/task.yaml`：默认选择加载插件的 thirdcase 任务，其他配置块保留为目录，只有 target.type 对应的块生效。
- `config/task.library-plugin.with.yaml`：独立 OpenCode + hmos-library-adapter-fast Agent。
- `config/task.library-plugin.without.yaml`：不加载目标 Plugin，使用宿主 build Agent。

两份配置都读取 `/Users/mayism/thirdcase`；当前识别到 `advanced_in_app_review`。源目录不修改，执行工程复制到每个样本的产物目录。Plugin、配置和数据库放入系统临时目录；关闭组会同时移除目标 Plugin 的配置引用、自动发现入口和关联技能。运行不会修改现有独立 OpenCode/HarmonyBot 配置。

被测插件只在 `target.type: plugin_agent` 和 `target.dir` 声明，不需要 execution.opencode.plugins。默认从 `package.json.main` 读取入口（未声明时使用 index.js）；非默认入口可用 target.entry 覆盖，初始化选项用 target.options。独立 OpenCode 默认从 PATH 查找，使用默认宿主配置时可省略整个 execution.opencode；仅在指定可执行文件或额外配置时设置其中的 binary/config_path。

```sh
# 本机插件任务使用智谱Coding Plan：glm-4.7 + 专用Coding接口。
# 仅在api_key填写ZHIPU_API_KEY变量名时需要export；直接填密钥时省略。
export ZHIPU_API_KEY='your-key'
harmony-eval run ./config/task.library-plugin.with.yaml --check
harmony-eval run ./config/task.library-plugin.with.yaml
harmony-eval run ./config/task.library-plugin.without.yaml
```

当前本机插件任务使用 `https://open.bigmodel.cn/api/coding/paas/v4`，与智谱普通API端点不同，按[智谱官方OpenCode接入说明](https://docs.bigmodel.cn/cn/coding-plan/tool/opencode)配置。白盒评估省略 model 时继承同一配置。

这不是自动生成两组：without_enable=false/true 各执行一组。插件关闭后，它注册的 Agent 不存在，所以 without 组需要明确配置仍可用的 build。当前 Flutter 库还需要实际 Flutter SDK，在 execution.enviroment.flutter_home 配置；本机默认 PATH 尚未发现 flutter。

当前三方库配置使用 LibraryAPICount 和独立白盒评估，输出 api_count_consistency（0—100）与 L3；不启用 LibraryTests / LibraryAPICompatibility，因此不要求先准备构建/功能验收命令和 API 映射。数量检查通过不能据此宣称通过编译、设备验证或功能验收；这些评估器可后续按需启用。

### 第一版三方库验收：API 数量

```yaml
verification:
  - id: api
    type: LibraryAPICount
scoring:
  - dimension: api_count_consistency
    type: ImmediateValue
    source: api.metrics.count_consistency
    scale: 100
```

Agent 执行前保存原工程的 input-evidence.json，执行后统计 base/ 的目标工程；复评沿用执行前快照，不读取修改后的工程伪造基线。各类别分别统计公开类型、方法／函数、属性／常量，输出转换前后数量、差值、带文件与行号的声明清单。产物位于用例目录的 verification/api/ 下：api-count.json 和 api-count.md。

- count_match：三类数量分别全部一致；total_match 仅表示总数相等。
- count_consistency：各类别 min(转换前数量, 转换后数量) 之和，除以各类别 max(转换前数量, 转换后数量) 之和。缺少或额外增加 API 都会降低分数；总数相同但类别不同也不满分。
- 统计采用语法树，支持 Dart、TypeScript、TypeScript 兼容的 ETS、ES 模块 JavaScript、Java、Kotlin。Dart 名称以下划线开头的声明、Java 非 public 成员、TS/JS 私有或 protected 成员、Kotlin private/protected/internal 声明均排除；JS/TS 统计显式导出声明及其公开成员。
- 重载按同一文件内的限定名称合并，getter/setter 合计一个属性；不统计构造函数、隐式生成或继承的成员，不展开外部 re-export，不比较签名、名称对应或功能实现。扫描范围内的内部 re-export 不额外增加计数。
- 默认排除测试、示例、依赖和构建目录。Flutter 工程默认统计 lib/ 中的 Dart 声明；其他工程优先 ETS/TS，再 ES 模块 JS，随后 Dart/Java/Kotlin。解析失败、不支持的源码或原库无公开声明时标记 unavailable，不能记作数量检查通过。

自动范围不适合某个库时，可在验证器配置 source_paths/target_paths（相对原工程/目标工程的文件或目录数组）、source_languages/target_languages（语言数组）。例如目标是独立 ArkTS 库但保留了原 Dart 代码时，显式指定 target_languages: [typescript]。统计口径是选定源码范围内的显式公开声明，不等同于完整解析包的导出边界；CommonJS 和 ETS 专有语法需后续扩展提取器。

## 数据集格式

### 一多

`dataset.type: swe-bench-hm-multi-dev` 沿用每个用例的 base/或task/、PROMPT.md、metadata.json、test_patch.patch 和 golden_patch.patch。工程生成后再在评估侧应用测试补丁；不会给被测 Agent 复制参考补丁。Web 用例保留 base 与 web 工程关系；Flutter/RN 沿用现有 ohosTest 执行流程。

### 三方库、安卓应用迁移

推荐 `library-migration` 或 `android-migration`，目录下每个子目录有 case.yaml：

```yaml
id: sample-library
input:
  project: ./source
  instruction: ./PROMPT.md
expected:
  tests: ./grading/tests
  api_mapping: ./grading/api-mapping.yaml
verification:
  tests:
    build_command: [node, --check, index.js]
    test_command: [node, test.js]
    junit_path: ./junit.xml
```

产物类型由提示词确定，不再配置 expected.output_kind/output_project。各用例的统一工程产物目录为 `variants/<with|without>/round-XX/cases/<id>/base/`，Agent 在该目录执行，目标工程根目录直接放在这里；框架会向迁移任务附加此约定。不同用例不会共用一个可写目录。Web 组合用例保留目录内部的容器工程与 web/ 关系。

可选的 input.target_template 用于提供目标工程模板：模板放入 base/，原工程副本放入同级 input/，提示词会告知 Agent 从 ../input/ 读取原工程。未提供模板时，原工程直接复制到 base/，可在副本内完成转换。

上面的命令仅展示配置方式，真实鸿蒙库应替换为其实际构建/测试命令。LibraryTests 内部复制生成工程、复制 grading/tests 到 evaluation-tests（tests_destination 可改）、执行构建和功能测试，读取 JUnit 统计。命令是参数数组，不通过 shell 拼接；支持 `${project}`、`${output}`。没有 JUnit 时，只有显式设置 exit_code_is_test_result=true 才把整条测试命令的结果视作一个通过率指标。

原始仓库没有 case.yaml 时可明确选择：

```yaml
dataset:
  type: library-migration
  dir: /path/to/thirdcase
  layout: repositories
  instruction: 请在当前工程内完成鸿蒙适配，保持公开API和原有平台行为。
  verification:
    tests:
      build_command: [your-build-command]
      test_command: [your-test-command]
      junit_path: ./junit.xml
```

repositories 表示 dir 本身是一个源工程，或其直接子目录各为一个源工程。构建/测试规范可在 dataset.verification 中共享；不同库规范不同时使用 case.yaml 的逐用例元数据。`dataset.case_ids` 可选部分用例，`limit` 可用于小规模试跑。

API 映射例子：

```yaml
apis:
  - source: OriginalApi
    target: HarmonyApi
    file: src/main/ets/Index.ets
    required_symbols: [HarmonyApi, evaluate]
    weight: 1
```

coverage 是声明的目标符号覆盖率，行为等价仍需功能测试。评估专用文件由评估侧使用，不传给生成 Agent。

### 文本问答

`dataset.type: text-qa` 接收 JSONL 文件或包含 JSONL 的目录：

```json
{"id":"q1","question":"2+3，只回答整数","reference_answers":["5"],"criteria":["结果正确"],"reference_documents":[]}
```

相同数据可评标准 OpenCode、HarmonyBot、MCP 开关实验和 HTTP 智能问答。knowledge 表示 HTTP 智能问答；本地 MCP 任务仍选择 opencode_agent/harmonybot_agent，只在实际 OpenCode 配置中修改 MCP enabled。

## 执行环境与评估流程

`execution.engine` 选择执行器，`execution.enviroment` 配置 deveco_home、flutter_home、sdk_home、java_home。独立 OpenCode 的 binary/config_path 放在 execution.opencode。HarmonyBot 自动定位有效 Bundle，并在私有副本合并 config_path；不会用仅含 MCP 的补充配置覆盖原有 Agent/Plugin 定义。

verification 的条目是完整评估流程，不单列编译节点。支持 UITest、CloudTest、LibraryAPICount、LibraryTests、LibraryAPICompatibility、whiteboxeval、LLM_judge、ExactMatch、ToolUsage、Command、SkillVerifier 和 Workflow。id 用于评分引用，depends_on 表达流程间的结果依赖；各流程在独立工程副本执行，设备按目标地址串行占用。评估器可选实现异步 capture_input(case, config)，在 Agent 执行前冻结 JSON 输入证据；后续 verify 读取相同证据。

- UITest 内部调用现有 Python ohosTest CLI，编译、安装、执行及截图能力沿用现有设备层，继承 YAML 环境；独立进程避免并发修改共享环境变量。
- CloudTest 复用现有 AGC 客户端与报告；认证使用现有 AGC 环境变量。文本 test_category 需提供明确 category_mapping，不能猜测服务数字类别。
- whiteboxeval 是独立模型的结构化源码/rubric评估；L3 取总分，L2 可按维度分配扣分并保留总分封顶。不把白盒判断当成已执行的设备测试。
- AGCDetection 与 CloudTest 分别配置：须提供 command 或明确 HTTP 协议，不能仅填名称就假设某个未知服务可用。
- ToolUsage 记录配置开关和实际调用。未观测到调用不代表已使用知识；observe 模式不把预期关闭的 MCP 判为失败。
- SkillVerifier 启动独立 OpenCode 评估会话，检查 required Skill 是否实际读取，并校验返回 JSON Schema。

组合流程不需要改核心代码：

```yaml
verification:
  - id: custom
    type: Workflow
    steps:
      - id: rule
        type: ExactMatch
    metrics:
      score: rule.metrics.score
```

也可用 workflow_path 指向独立工作流文件，其中的相对路径以该文件所在目录为基准，支持嵌套与循环引用校验。复评身份包括流程文件、提示词、rubric、Skill 内容和适配器版本，内容改变后不会把旧评分当作最新结果。新工具适配器可通过 Python 包 entry points 注册到 harmony_eval.datasets、harmony_eval.targets、harmony_eval.execution、harmony_eval.verification、harmony_eval.scoring、harmony_eval.http_protocols；注册项可声明 schema、validate、version，框架不维护场景 if/else 分发表。

## 输出与验证范围

`report.output_dir/<run_id>/` 下保存 task.resolved.yaml、task-report.json、index.html、EvalScope 原生缓存，以及 variants/<with|without>/round-XX/cases/<id>/ 下的工程、change.patch、Agent 轨迹及必要评估证据。配置快照脱敏，不保存模型密钥。可重建的运行配置、数据库及评估工程副本使用系统临时目录。

generate/agent-output.html 是会话浏览入口；agent-output.json 保存结构化会话及模型代理轨迹，events.jsonl 是 OpenCode CLI 原始事件，stderr.jsonl 是进程错误输出。执行器在删除运行期数据库前，仅从本次私有 XDG_DATA_HOME 只读导出主会话和全部后代会话，不搜索用户全局数据库。session_capture 字段说明实际导出模式；数据库不兼容时明确回退为 CLI 事件，不能据此声称已取得子会话。超时也保存已有回复、子会话和模型轨迹。

OpenCode CLI 的主会话事件流可能不显示子 Agent 的实时工具进度。三方库插件配置将 idle_timeout 与 timeout 同设为 3600 秒，通过总时限控制整轮执行，避免子 Agent 下载依赖、分析或构建时因主会话静默 5 分钟而被提前终止。需要更长执行时间时调整 timeout 和 idle_timeout；进程结束不等同于转换成功，仍以执行状态和评估证据为准。

本地自验证覆盖 EvalScope HTTP 生命周期、真实 OpenCode+本地模型代理的工具调用/生成/功能测试、Plugin/Skill/MCP 配置隔离、失败与缺失证据、复评与复算和扩展流程。真实 DevEco 编译、模拟器/真机、AGC 服务仍需对应工具链、设备和账号后执行；本地模拟通过不等于真实库已转换成功。

自验证命令（已安装 `.[eval]` 的 Python 环境）：

```sh
python -m unittest discover -s tests -p 'test_harmony_eval*.py' -v
HARMONY_EVAL_INTEGRATION=1 python -m unittest discover -s tests -p test_harmony_eval_opencode.py -v
```

第二条需要本机独立 OpenCode，使用本地模型服务，不请求付费模型。当前验证记录位于 `generate/harmony-eval-validation.json`，包含插件开关预检、原有链路回归结果及正式运行缺项。
