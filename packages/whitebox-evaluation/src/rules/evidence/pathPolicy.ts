// 规则静态判定默认跳过测试源码，避免测试样例影响业务代码审计结论。
export const RULE_EVALUATION_IGNORED_PATH_PREFIXES = ["entry/src/test", "entry/src/ohosTest"];

const RULE_EVALUATION_IGNORED_PATH_PATTERN = /(?:^|\/)src\/(?:test|ohosTest)(?:\/|$)/;

export function isRuleEvaluationIgnoredPath(relativePath: string): boolean {
  return RULE_EVALUATION_IGNORED_PATH_PATTERN.test(relativePath);
}
