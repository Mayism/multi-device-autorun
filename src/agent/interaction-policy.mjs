const AFFIRMATIVE = /(?:允许|同意|确认|继续|执行|应用|保存|覆盖|启用|接受|推荐|默认|好的|可以|是|\b(?:allow|approve|confirm|continue|proceed|accept|recommended|default|yes|ok)\b)/i;
const NEGATIVE = /(?:取消|拒绝|停止|终止|放弃|跳过|稍后|不允许|不同意|否|\b(?:cancel|reject|deny|stop|abort|skip|later|no)\b)/i;

export const AUTOMATIC_CONFIRMATION_TEXT = "允许，请继续执行；如需选择，请采用推荐或默认方案。";

function optionText(option) {
  return `${String(option?.label || option?.value || "")} ${String(option?.description || "")}`.trim();
}

function optionScore(option, index) {
  const text = optionText(option);
  let score = index === 0 ? 1 : 0;
  if (AFFIRMATIVE.test(text)) score += 20;
  if (NEGATIVE.test(text)) score -= 50;
  return score;
}

export function buildAutomaticQuestionAnswers(questions) {
  const answers = [];
  for (const question of Array.isArray(questions) ? questions : []) {
    const options = Array.isArray(question?.options) ? question.options : [];
    if (!options.length) {
      answers.push([AUTOMATIC_CONFIRMATION_TEXT]);
      continue;
    }
    let selectedIndex = 0;
    let selectedScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < options.length; index += 1) {
      const score = optionScore(options[index], index);
      if (score > selectedScore) {
        selectedIndex = index;
        selectedScore = score;
      }
    }
    const label = String(options[selectedIndex]?.label || options[selectedIndex]?.value || "").trim();
    answers.push([label || AUTOMATIC_CONFIRMATION_TEXT]);
  }
  return answers;
}

function requestId(item) {
  return String(item?.id || item?.requestID || item?.requestId || "");
}

export async function handlePendingInteractions({
  client,
  projectDir,
  repliedQuestions,
  repliedPermissions,
  onActivity,
  onProgress,
}) {
  let pending = 0;
  let replied = 0;
  const errors = [];

  try {
    const questions = await client.listQuestions(projectDir);
    for (const item of Array.isArray(questions) ? questions : []) {
      const id = requestId(item);
      if (!id || repliedQuestions.has(id)) continue;
      pending += 1;
      try {
        const answers = buildAutomaticQuestionAnswers(item?.questions || []);
        if (!answers.length) throw new Error("question 请求未包含可回答的问题");
        await client.replyQuestion(id, answers, projectDir);
        repliedQuestions.add(id);
        pending -= 1;
        replied += 1;
        onActivity?.();
        onProgress?.("question_replied", { requestId: id, answers });
      } catch (error) {
        errors.push({ kind: "question", requestId: id, error: error.message });
        onProgress?.("interaction_error", { kind: "question", requestId: id, error: error.message });
      }
    }
  } catch (error) {
    errors.push({ kind: "question_list", error: error.message });
    onProgress?.("interaction_error", { kind: "question_list", error: error.message });
  }

  try {
    const permissions = await client.listPermissions(projectDir);
    for (const item of Array.isArray(permissions) ? permissions : []) {
      const id = requestId(item);
      if (!id || repliedPermissions.has(id)) continue;
      pending += 1;
      try {
        const permission = String(item?.permission || "").trim().toLowerCase();
        await client.replyPermission(id, projectDir, "always");
        repliedPermissions.add(id);
        pending -= 1;
        replied += 1;
        onActivity?.();
        onProgress?.("permission_replied", { requestId: id, permission, reply: "always" });
      } catch (error) {
        errors.push({ kind: "permission", requestId: id, error: error.message });
        onProgress?.("interaction_error", { kind: "permission", requestId: id, error: error.message });
      }
    }
  } catch (error) {
    errors.push({ kind: "permission_list", error: error.message });
    onProgress?.("interaction_error", { kind: "permission_list", error: error.message });
  }

  return { pending, replied, errors };
}
