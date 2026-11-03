# HarmonyEval 开发约定

## 所有修改都要考虑 Windows

本节适用于本仓库的所有修改，包括代码、脚本、配置、测试和文档中的运行示例，不局限于评测场景开发。Windows 与 macOS/Linux 都是支持平台；不能因为本机能运行就默认跨平台兼容。

1. **文件编码明确指定。**源码、配置、日志和报告默认使用 UTF-8。新增或修改 Python 文本读写时，显式指定 `encoding="utf-8"`，包括 `open()`、`Path.read_text()`、`Path.write_text()` 和日志文件处理器；不依赖 Windows 的 GBK/CP936 默认编码。外部输入确实可能带 UTF-8 BOM 时，可用 `utf-8-sig` 读取；其他编码按输入协议处理，不能把二进制当文本。
2. **子进程输出和文件编码分开处理。**`subprocess` 的 `text=True` 不代表 UTF-8；根据工具实际协议显式指定编码，或先捕获字节再经统一辅助函数解码。Windows 工具可能输出 GBK/GB18030，不能一律假设 UTF-8。协议不明时保留原始字节并明确解码策略；不要用 `errors="ignore"` 丢弃证据，也不要把替换后的损坏 JSON 当作有效验收结果。
3. **控制台不能因字符不支持而崩溃。**考虑重定向输出和 GBK 终端；日志不依赖 Emoji、特殊箭头等字符才能表达状态。向受限编码输出时采用明确的安全转义/降级策略，不能让 `UnicodeEncodeError` 掩盖业务结果。给 Python 子进程设置 `PYTHONUTF8`/`PYTHONIOENCODING` 可作为补充，但不替代显式文件编码，也不能据此认定 Node/Java/原生工具会输出 UTF-8。
4. **路径、命令和进程使用跨平台方式。**优先复用现有辅助函数以及 `pathlib`、`tempfile`、`shutil.which`、参数数组；处理盘符、反斜杠、中文和空格路径、`.cmd/.bat/.exe` 入口、文件占用与进程树清理。不能把 `/tmp`、POSIX shell、符号链接权限或 `chmod` 当作 Windows 默认能力；文档按需要提供 PowerShell 写法。
5. **验证与实际修改相匹配。**涉及编码、文件、进程或 CLI 输出的逻辑变更，应覆盖 UTF-8 与实际工具可能使用的 GBK/GB18030、中文/空格路径，以及 GBK 无法表示的字符（如 Emoji）的处理。区分日志容错和结构化结果严格解析；相关编码错误不得静默变成通过、零分或满分。纯文案修改无需运行整套 Windows 测试。
6. **报告验证范围。**交付时说明 Windows 兼容处理和验证方式；只有在真实 Windows 上运行过才能称为 Windows 实测通过。本机模拟编码的测试不能替代完整 Windows 验证。

## 评测框架开发

新增或修改评测场景、task YAML、用例集适配器、验证流程、评分规则，以及相关框架架构时，先读取并遵循 [.agents/skills/harmonyeval/SKILL.md](.agents/skills/harmonyeval/SKILL.md)，再按任务读取其参考文件。

该 Skill 随仓库维护，接口以当前源码为准。调整接口或注册机制时，同步更新 Skill 中受影响的示例与约束。其他类型的工作不必加载此 Skill。
