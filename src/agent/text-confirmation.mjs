import { BASIC_TESTS_REPLY, requestsBasicTestsConfirmation } from "./multimodal-fallback.mjs";

export const CONTINUE_TASK_REPLY = "是，请继续执行当前任务，按既定流程推进；如需选择，请采用推荐或默认方案。";

// 识别确认问法，不再枚举后面的动作动词。
const CONFIRMATION_QUESTION = new RegExp(
  `(?:^|[,，:：]\\s*)(?:(?:请问|请(?:您)?确认|(?:需要|等待)(?:您|用户)确认)[,，:：]?\\s*)?`
  + `(?:(?:您|你)(?:希望|想要)?|我们|我)?(?:是否|要不要|能否|可否|需不需要|可不可以|能不能|行不行|同不同意)`, "i",
);
const CONFIRMATION_END = /(?:可以吗|好吗|行吗|同意吗|吗)\s*[?。]?$/;
const CONFIRMATION_REQUEST = /(?:请(?:您)?|需要(?:您|用户)|等待(?:您|用户))确认/;

function normalizedText(value) {
  return String(value || "").normalize("NFKC")
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
    .replace(/\\([*_`])/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/[ \t]+/g, " ");
}

function questionClauses(text) {
  return text.split(/(?<=[。!?;；\n])/)
    .map(raw => raw.trim().replace(/^(?:>\s*|[-*+]\s+|\d+[.)、]\s*)+/, ""))
    // 不把流程说明、测试步骤或已回答的历史问题当作新请求。
    .filter(clause => !/User has answered|\[output\]|如果|假如|无需|不用|不必|不需要/.test(clause)
      && !/^(?:测试用例|验证项|检查项|检查是否|验证是否)/.test(clause));
}

function isConfirmation(clause) {
  return CONFIRMATION_QUESTION.test(clause) || CONFIRMATION_END.test(clause) || CONFIRMATION_REQUEST.test(clause);
}

function needsHumanAnswer(clause, { hasOptions = false } = {}) {
  // 开放式选择与必填输入不能通过一个“是”解决。
  if (/(?:请|需要|等待)(?:您|你|用户)?(?:先)?(?:提供|输入|填写|告知|指定)/.test(clause)) return true;
  if (/(?:您|你)(?:能否|能不能|可否|是否可以|可以|能)(?:提供|输入|填写|告知|指定)/.test(clause)) return true;
  if (!hasOptions && /(?:请选择|选哪个|选择哪个|哪一种|哪个方案|何时|什么时候|多少|怎么选)/.test(clause)) return true;
  if (!isConfirmation(clause) && !/是否|\?/.test(clause)) return false;
  if (!hasOptions && /还是|或者|或是|[A-Z一二三123]\s*或\s*[A-Z一二三123]/i.test(clause)) return true;
  // 反向确认保留给用户，避免“是”被理解成停止、放弃或跳过。
  if (/停止|终止|暂停|取消|放弃|跳过|暂缓|不再继续/.test(clause)) return true;
  if (/(?:切换|更换)[^。!?\n]{0,20}模型|(?:继续|进行|执行)[^。!?\n]{0,10}(?:多模态|视觉)测试/.test(clause)) return true;
  // 效果验收、事实状态需要证据或用户判断，不能替用户肯定。
  if (/(?:是否|能否|可否)(?:仍然|仍|继续|已经|已|都|您认为|你觉得)?(?:正确|成功|完成|通过|符合|满足|满意|接受|看清|看懂)/.test(clause)) return true;
  if (/是否(?:可以|能够)?(?:接受|认可)|(?:请(?:您)?|需要(?:您|用户))确认(?:一下)?(?:这个|当前|现在的)?(?:页面|布局|预览|效果|设计|结果)/.test(clause)) return true;
  if (/是否(?:已经|已|正在)|是否[^。!?;；\n]{0,20}(?:了|过)(?:预览|报告|下一阶段|吗|[?。])/.test(clause)) return true;
  if (/(?:正确|成功|完成|通过|符合预期|满意|满足要求|看清|看懂|喜欢)(?:了)?吗/.test(clause)) return true;
  if (/(?:效果|布局|页面|预览|交互|设计|结果)[^。!?;；\n]{0,20}(?:是否(?:合适|满意|正确|符合|满足|需要调整)|符合预期|满意吗|可以接受)/.test(clause)) return true;
  if (/^(?:这个|当前|现在的)?(?:效果|布局|页面|预览|交互|设计|结果)(?:可以|行|好吗|怎么样|如何|OK)/i.test(clause)) return true;
  if (/是否(?:执行|生成|进入|构建|编译|测试)(?:了|过|完|成功|失败)/.test(clause)) return true;
  return false;
}

export function requiresManualConfirmation(value, options) {
  return questionClauses(normalizedText(value)).some(clause => needsHumanAnswer(clause, options));
}

export function automaticTextReply(value) {
  const text = normalizedText(value);
  // 专用降级策略优先于通用“继续”，避免让不支持图片的模型继续视觉测试。
  if (requestsBasicTestsConfirmation(text)) {
    return { text: BASIC_TESTS_REPLY, reason: "multimodal_unavailable" };
  }
  const clauses = questionClauses(text);
  // 一条消息同时包含验收和继续执行的问题时，不能用一个肯定答复全部确认。
  if (clauses.some(clause => needsHumanAnswer(clause))) return null;
  const needsConfirmation = clauses.some(isConfirmation);
  return needsConfirmation ? { text: CONTINUE_TASK_REPLY, reason: "workflow_confirmation" } : null;
}
