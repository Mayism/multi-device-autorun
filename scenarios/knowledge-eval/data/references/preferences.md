# 人工整理的评价参考：Preferences

来源：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-data-preferences
核验日期：2026-11-02；从官方知识 MCP 检索并核验对应文档。

XML 模式先修改 Preferences 缓存，通过 flush 写入持久化文件，异步保存要处理结果。GSKV 模式的数据操作实时落盘，不需要调用 XML 模式的 flush。评价时应区分存储模式，不以是否背出某个完整代码示例为硬门槛。
