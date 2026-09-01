/** 判断完成后是否需要保留 Code Linter / hvigor 诊断产物。 */
export function shouldKeepCodeLinterResults(result: Record<string, unknown>): boolean {
  const officialLinterRunStatus = result.officialLinterRunStatus;
  const hvigorBuildCheckStatus = result.hvigorBuildCheckStatus;
  return (
    (typeof officialLinterRunStatus === "string" && officialLinterRunStatus !== "not_enabled") ||
    (typeof hvigorBuildCheckStatus === "string" && hvigorBuildCheckStatus !== "not_enabled")
  );
}
