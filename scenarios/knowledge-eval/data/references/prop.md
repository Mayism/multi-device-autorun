# 人工整理的评价参考：@Prop

来源：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-state-management-prop
核验日期：2026-11-02；从官方知识 MCP 检索并核验对应文档。

这是 V1 状态管理的单向同步：父组件 @State 等状态更新会传到对应子组件 @Prop；子组件的局部修改不会反向改变父组件。评价重点是数据方向和适用场景，不要求引用链接字符完全一致。
