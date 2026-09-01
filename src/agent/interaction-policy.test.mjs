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
