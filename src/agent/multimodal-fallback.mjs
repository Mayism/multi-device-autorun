export const BASIC_TESTS_REPLY = "仅基础测试";

function normalizedText(value) {
  return String(value || "").normalize("NFKC")
    .replace(/\*\*|__|`/g, "")
    .replace(/[ \t]+/g, " ");
}

const CAPABILITY_FAILURES = [
  /(?:多模态|(?:图片|图像|视觉)(?:理解|识别)?)(?:能力)?(?:探测|检测)(?:未通过|失败|不通过)/,
  /(?:多模态|图片理解|图像理解|视觉理解)(?:能力)?(?:不足|不可用|不受支持)/,
  /(?:未通过|不支持|不具备|缺乏|缺少)(?:(?:图片|图像|视觉)(?:理解|识别|输入)|多模态)/,
  /(?:无法|不能|不支持|没法)(?:直接)?(?:读取|识别|理解|查看|看懂|分析|处理)(?:上传的|提供的)?(?:图片|图像|截图)/,
  /(?:无法|不能|没法)看图|(?:图片|图像|截图)(?:看不了|看不懂|无法理解|无法读取)/,
];

export function hasBasicTestsOption(value) {
  const text = normalizedText(value);
  return /基础(?:测试|验证|检查)/.test(text)
    || /(?:构建|编译)(?:和|及|与|、)静态(?:检查|分析)/.test(text)
    || /(?:不依赖|不涉及|无需)(?:设备)?(?:截图|图片|图像|视觉)(?:的)?(?:测试|验证|检查)/.test(text);
}

export function requestsBasicTestsConfirmation(value, { structuredQuestion = false } = {}) {
  const text = normalizedText(value);
  const clauses = text.split(/(?<=[。!?;；\n])/).map(clause => clause.trim()).filter(Boolean);
  // 失败表述必须指向图片理解能力；假设性的流程说明不算本次探测失败。
  const capabilityFailed = clauses.some(clause => !/(?:如果|假如|倘若|若)/.test(clause)
    && CAPABILITY_FAILURES.some(pattern => pattern.test(clause)));
  if (!capabilityFailed || !hasBasicTestsOption(text)) return false;
  // Question 工具本身就是一个待回答请求，选项可以提供降级方式。
  if (structuredQuestion) return true;

  const actionableClauses = clauses.filter(clause => !/(?:无需|不用|不必|不需要)[^。!?\n]{0,16}(?:确认|选择|回复|回答)/.test(clause));
  const confirmation = /请(?:您)?(?:选择|确认|回复|决定)|(?:需要|等待)(?:您|用户)(?:选择|确认|回复|决定)|是否|要不要|愿不愿意|还是|吗|\?/;
  if (actionableClauses.some(clause => hasBasicTestsOption(clause) && confirmation.test(clause))) return true;

  // 兼容“请选择后续测试方式：”之后另起行列出基础测试选项。
  return actionableClauses.some((clause, index) => (
    /(?:请(?:您)?(?:选择|确认|决定)|需要(?:您|用户)(?:选择|确认|决定))[^。!?\n]{0,30}(?:方式|方案|模式)\s*[:：。?]?$/.test(clause)
    || /(?:请选择|请您选择|是否继续)\s*[:：。?]?$/.test(clause)
  ) && actionableClauses.slice(index + 1).some(hasBasicTestsOption));
}
