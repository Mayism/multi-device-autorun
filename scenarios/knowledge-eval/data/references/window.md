# 人工整理的评价参考：Window

来源：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-window-window
核验日期：2026-11-02；从官方知识 MCP 检索并核验对应文档。

setWindowLayoutFullScreen 处理沉浸式布局，决定是否避让系统栏区域，不直接表示系统栏被隐藏。setWindowSystemBarEnable 负责主窗口系统栏可见性。当前文档中 status 控制相关系统栏，navigation 参数无效果；调用返回不代表显示或隐藏完成。非全屏/最大化主窗口的配置有生效限制，并存在设备行为差异。此参考是日期固定的摘要；文档更新后应重新核验，不把训练记忆当成最新规范。
