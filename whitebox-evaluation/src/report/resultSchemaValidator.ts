import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

// 在落盘前做一次 schema gate，避免无效 result.json 进入后续流程。
export function validateReportResult(
  resultJson: Record<string, unknown>,
  schemaPath: string,
): void {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as object;
  // `ajv/dist/2020` 的类型声明与运行时导出形式不完全一致，这里做一次窄化。
  const Ajv2020Ctor = Ajv2020 as unknown as new (options?: {
    strict?: boolean;
    allErrors?: boolean;
  }) => {
    compile: (inputSchema: object) => {
      (value: unknown): boolean;
      errors?: Array<{
        instancePath?: string;
        message?: string;
        params?: {
          additionalProperty?: string;
        };
      }>;
    };
    errorsText: (errors?: unknown[]) => string;
  };
  const ajv = new Ajv2020Ctor({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);

  if (!validate(resultJson)) {
    const detail = validate.errors
      ?.map((error) => {
        const property = error.params?.additionalProperty
          ? ` property=${error.params.additionalProperty}`
          : "";
        return `${error.instancePath || "/"} ${error.message ?? ""}${property}`.trim();
      })
      .join("; ");
    // 直接抛错，让调用方中止写盘/上传，而不是悄悄吞掉不合法输出。
    throw new Error(`Schema validation failed: ${detail || ajv.errorsText(validate.errors)}`);
  }
}
