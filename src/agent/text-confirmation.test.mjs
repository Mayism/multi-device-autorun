import assert from "node:assert/strict";
import test from "node:test";
import { automaticTextReply, CONTINUE_TASK_REPLY } from "./text-confirmation.mjs";

test("execution confirmations accept varied wording and Markdown", () => {
  for (const text of [
    "1. 是否继续进入 **B02 导航框架**（全局 Tabs 导航栏 SM/MD 底部 ↔ LG/XL 左侧竖向 + 追剧页编辑按钮挪移）的 SPEC 生成与高保真预览？",
    String.raw`1. 是否继续进入 \*\*B02 导航框架\*\* 的 SPEC 生成与高保真预览？`,
    "B02 涉及弹框多形态差异与播放器偏移，是否先生成高保真预览？",
    "是否进入下一阶段？", "是否继续？", "请确认是否继续按账本执行。",
    "要不要先生成 SPEC？", "是否可以开始修复？", "需要您确认是否执行后续任务。",
    "我继续生成高保真预览，可以吗？", "继续吗？", "能否进入 B03？",
    "是否采用推荐方案？", "能不能整理一下报告？", "是否由我补齐账本记录？",
    "要不要重新跑一下检查？", "可以按默认配置处理吗？", "请确认后我会处理剩余任务。",
    "可不可以补充说明？", "我们按原计划处理，您同意吗？",
  ]) assert.deepEqual(automaticTextReply(text), { text: CONTINUE_TASK_REPLY, reason: "workflow_confirmation" }, text);
});

test("status reports and result validation do not receive an affirmative reply", () => {
  for (const text of [
    "B02 的 SPEC 和高保真预览已生成。", "接下来继续进入 B03。",
    "页面是否正确？", "是否符合预期？", "是否继续符合预期？", "是否已完成适配？",
    "布局是否满意？", "预览效果可以接受吗？", "这个布局可以吗？",
    "是否可以接受当前布局？", "请确认当前预览效果后继续。", "布局是否需要调整？",
    "是否停止执行？", "要不要放弃当前任务？", "可以跳过剩余步骤吗？",
    "是否先暂停？", "是否不再继续？",
    "是否采用 A 或 B？", "先做导航还是播放器？", "请选择 A 或 B。",
    "请输入账号。", "需要您提供测试设备编号。", "请告知报告保存路径。",
    "您能提供账号吗？",
    "页面是否符合预期？\n是否继续进入 B03？",
    "是否继续？\n请提供账号。",
    "是否执行成功？", "是否生成了预览？", "是否进入了下一阶段？",
    "检查是否进入 B02，记录结果。", "测试用例：验证是否生成预览。",
    "无需确认是否继续，我将自动执行。", "如果需要更多内容，是否继续生成预览？",
    "是否切换模型？", "是否继续切换到支持图片的模型？",
    "当前模型不支持图片理解，是否继续多模态测试？",
    '[output] User has answered your questions: "是否先生成高保真预览？"="先生成高保真预览（推荐）". You can now continue.',
    "```text\n是否进入 B02？\n```",
  ]) assert.equal(automaticTextReply(text), null, text);
});

test("multimodal fallback takes priority over workflow continuation", () => {
  assert.deepEqual(automaticTextReply("图片看不了，是否继续基础测试？\n是否进入下一阶段？"), {
    text: "仅基础测试", reason: "multimodal_unavailable",
  });
});
