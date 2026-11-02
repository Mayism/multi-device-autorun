# HarmonyEval 开发约定

新增或修改评测场景、task YAML、用例集适配器、验证流程、评分规则，以及相关框架架构时，先读取并遵循 [.agents/skills/harmonyeval/SKILL.md](.agents/skills/harmonyeval/SKILL.md)，再按任务读取其参考文件。

该 Skill 随仓库维护，接口以当前源码为准。调整接口或注册机制时，同步更新 Skill 中受影响的示例与约束。其他类型的工作不必加载此 Skill。
