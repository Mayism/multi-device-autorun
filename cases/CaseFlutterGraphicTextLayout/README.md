# 图文排版一多适配综合评测用例

## 用例标识

- **case_id**: `case-graphic-text-layout`
- **模式**: `derive_base`（基于基础工程派生）
- **适配领域**: 图文排版-一多适配

## 用例概述

本用例评测 Agent 将图文排版工程的一多适配测试用例

目录结构：

```
CaseGraphicTextLayout/
├── README.md              # 说明文档
├── CHANGELOG.md           # 版本记录
├── PROMPT.md              # 提示词
├── metadata.json          # 用例元数据（commit、测试定义等）
├── golden_patch.patch     # 参考实现补丁
├── test_patch.patch       # 测试代码补丁
└── base/                  # 任务工程代码（待适配的基础工程）
```



## 单元测试用例

### fail_to_pass（修复后应通过）

| 测试套 | 测试用例名称 | 验证内容 |
|---|---|---|
| MdFailToPassTest | `should_sixty_forty_columns_on_md_breakpoint` | MD断点下6:4分栏布局（图左文右） |
| LgFailToPassTest | `should_fifty_fifty_columns_on_lg_breakpoint` | LG/XL断点下5:5分栏布局 |

### pass_to_pass（原有功能不受影响）

| 测试套 | 测试用例名称 | 验证内容 |
|---|---|---|
| SmPassToPassTest | `should_vertical_layout_on_sm_breakpoint` | SM断点下垂直布局（图上文下，文字整宽） |
