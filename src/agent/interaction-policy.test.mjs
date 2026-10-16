import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATIC_CONFIRMATION_TEXT,
  buildAutomaticQuestionAnswers,
  handlePendingInteractions,
} from "./interaction-policy.mjs";

test("questions prefer affirmative or recommended options and answer free text", () => {
  assert.deepEqual(buildAutomaticQuestionAnswers([
    { options: [{ label: "取消" }, { label: "允许并继续" }] },
    { options: [{ label: "方案 A" }, { label: "推荐方案" }] },
    { options: [{ label: "否" }, { label: "是" }] },
    { question: "是否继续？" },
  ]), [
    ["允许并继续"],
    ["推荐方案"],
    ["是"],
    [AUTOMATIC_CONFIRMATION_TEXT],
  ]);
});

test("effect reviews, reverse confirmations and required input remain pending", async () => {
  for (const question of ["页面是否符合预期？", "布局是否满意？", "是否停止执行？", "请输入账号。"]) {
    assert.deepEqual(buildAutomaticQuestionAnswers([{ question }]), [], question);
    assert.deepEqual(buildAutomaticQuestionAnswers([{ question, options: [{ label: "是" }, { label: "否" }] }]), [], question);
  }
  assert.deepEqual(buildAutomaticQuestionAnswers([
    { question: "是否继续？" }, { question: "效果是否满意？" },
  ]), []);
  let replies = 0;
  const repliedQuestions = new Set();
  const result = await handlePendingInteractions({
    client: {
      listQuestions: async () => [{ id: "review", questions: [{ question: "页面是否符合预期？" }] }],
      replyQuestion: async () => { replies += 1; },
      listPermissions: async () => [],
    },
    projectDir: "project", repliedQuestions, repliedPermissions: new Set(),
  });
  assert.equal(replies, 0);
  assert.equal(repliedQuestions.size, 0);
  assert.equal(result.pending, 1);
  assert.equal(result.questionsReplied, 0);
  assert.deepEqual(result.errors, []);
});

test("pending permissions are always approved and transient failures remain pending", async () => {
  let permissionAttempts = 0;
  const progress = [];
  const client = {
    listQuestions: async () => [{ id: "q1", questions: [{ options: [{ label: "否" }, { label: "是，继续" }] }] }],
    replyQuestion: async (_id, answers) => assert.deepEqual(answers, [["是，继续"]]),
    listPermissions: async () => [{ id: "p1", permission: "external_directory" }],
    replyPermission: async (_id, _dir, reply) => {
      permissionAttempts += 1;
      assert.equal(reply, "always");
      if (permissionAttempts === 1) throw new Error("temporary failure");
    },
  };
  const repliedQuestions = new Set();
  const repliedPermissions = new Set();
  const input = {
    client,
    projectDir: "project",
    repliedQuestions,
    repliedPermissions,
    onProgress: (event, data) => progress.push({ event, data }),
  };

  const first = await handlePendingInteractions(input);
  assert.equal(first.pending, 1);
  assert.equal(first.errors.length, 1);
  assert.equal(repliedQuestions.has("q1"), true);
  assert.equal(repliedPermissions.has("p1"), false);

  const second = await handlePendingInteractions(input);
  assert.equal(second.pending, 0);
  assert.equal(second.errors.length, 0);
  assert.equal(repliedPermissions.has("p1"), true);
  assert.equal(progress.some((item) => item.event === "interaction_error"), true);
});

test("multimodal fallback questions choose basic tests instead of switching models", () => {
  assert.deepEqual(buildAutomaticQuestionAnswers([{
    question: "当前模型未通过图片理解探测，请选择后续测试方式。",
    options: [{ label: "继续多模态测试", description: "请切换模型后继续" }, { label: "仅基础测试" }],
  }]), [["仅基础测试"]]);
  assert.deepEqual(buildAutomaticQuestionAnswers([{
    question: "当前模型不支持图片理解，请回复仅基础测试或切换模型。",
  }]), [["仅基础测试"]]);
  assert.deepEqual(buildAutomaticQuestionAnswers([{
    question: "多模态探测已通过，请选择后续测试方式。",
    options: [{ label: "仅基础测试" }, { label: "继续多模态测试" }],
  }]), [["继续多模态测试"]]);
});

test("varied multimodal questions use the same fallback policy as text confirmations", () => {
  assert.deepEqual(buildAutomaticQuestionAnswers([
    { question: "图片看不了，要不要先跑不依赖截图的检查？" },
    { question: "模型不具备视觉理解能力，后续测试方式", options: [
      { label: "继续多模态测试", description: "切换模型" },
      { label: "只做基础验证" },
    ] },
    { question: "多模态探测已通过，请选择测试方式", options: [
      { label: "基础测试" },
      { label: "切换模型并继续多模态测试" },
    ] },
  ]), [["仅基础测试"], ["只做基础验证"], ["切换模型并继续多模态测试"]]);
});
