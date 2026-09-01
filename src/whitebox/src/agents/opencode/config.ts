import fs from "node:fs/promises";
import path from "node:path";

export interface OpencodeRuntimeConfig {
  host: string;
  port: number;
  serverUrl: string;
  configPath: string;
  configDir: string;
  runtimeDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export class OpencodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpencodeConfigError";
  }
}

const REQUIRED_ENV_KEYS = [
  "HMOS_OPENCODE_PORT",
  "HMOS_OPENCODE_HOST",
  "HMOS_OPENCODE_PROVIDER_ID",
  "HMOS_OPENCODE_MODEL_ID",
  "HMOS_OPENCODE_PROVIDER_CONFIG",
  "HMOS_OPENCODE_TIMEOUT_MS",
  "HMOS_OPENCODE_MAX_OUTPUT_BYTES",
] as const;

type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

type JsonObject = Record<string, unknown>;

function requiredEnv(env: NodeJS.ProcessEnv): Record<RequiredEnvKey, string> {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new OpencodeConfigError(`缺少 opencode 环境变量：${missing.join(", ")}`);
  }

  return Object.fromEntries(REQUIRED_ENV_KEYS.map((key) => [key, env[key]!.trim()])) as Record<
    RequiredEnvKey,
    string
  >;
}

function rejectPlaceholderValue(value: string, key: RequiredEnvKey): void {
  const placeholders: Partial<Record<RequiredEnvKey, Set<string>>> = {
    HMOS_OPENCODE_MODEL_ID: new Set(["score-model", "replace_me", "your-model-id"]),
  };
  if (placeholders[key]?.has(value)) {
    throw new OpencodeConfigError(`${key} 仍是示例占位值，请在 .env 中配置真实 opencode 模型服务参数`);
  }
}

function parsePositiveInteger(value: string, key: RequiredEnvKey): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new OpencodeConfigError(`${key} 必须是正整数`);
  }
  return parsed;
}

function replaceTemplateVariables(
  template: string,
  values: Record<RequiredEnvKey, string>,
): string {
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new OpencodeConfigError(`opencode 配置模板包含未知占位符：${match}`);
    }
    return values[key as RequiredEnvKey];
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyProviderConfig(
  config: unknown,
  values: Record<RequiredEnvKey, string>,
): unknown {
  if (!isJsonObject(config)) {
    throw new OpencodeConfigError("opencode 配置模板根节点必须是 JSON 对象");
  }

  const providerId = values.HMOS_OPENCODE_PROVIDER_ID;
  let providerConfig: unknown;
  try {
    providerConfig = JSON.parse(values.HMOS_OPENCODE_PROVIDER_CONFIG) as unknown;
  } catch (error) {
    throw new OpencodeConfigError(
      `OpenCode Provider ${providerId} 配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isJsonObject(providerConfig)) {
    throw new OpencodeConfigError(`OpenCode Provider ${providerId} 配置必须是 JSON 对象`);
  }
  config.provider = {
    [providerId]: providerConfig,
  };
  return config;
}

async function ensureRuntimeDirectories(runtimeDir: string): Promise<void> {
  await Promise.all(
    [
      runtimeDir,
      path.join(runtimeDir, "home"),
      path.join(runtimeDir, "xdg-config"),
      path.join(runtimeDir, "xdg-config", "opencode"),
      path.join(runtimeDir, "xdg-state"),
      path.join(runtimeDir, "xdg-data"),
      path.join(runtimeDir, "xdg-cache"),
      path.join(runtimeDir, "prompts"),
      path.join(runtimeDir, "formatters"),
      path.join(runtimeDir, "skills"),
      path.join(runtimeDir, "xdg-config", "opencode", "skills"),
    ].map((dirPath) => fs.mkdir(dirPath, { recursive: true })),
  );
}

async function copyFilesFromDirectory(input: {
  sourceDir: string;
  targetDir: string;
  label: string;
}): Promise<void> {
  await fs.mkdir(input.targetDir, { recursive: true });
  const entries = await fs.readdir(input.sourceDir, { withFileTypes: true }).catch((error: unknown) => {
    throw new OpencodeConfigError(
      `无法读取 opencode ${input.label} 目录：${error instanceof Error ? error.message : String(error)}`,
    );
  });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const sourcePath = path.join(input.sourceDir, entry.name);
        const targetPath = path.join(input.targetDir, entry.name);
        await fs.copyFile(sourcePath, targetPath);
      }),
  );
}

const REQUIRED_SKILL_NAMES = [
  "hmos-understanding",
  "hmos-rubric-scoring",
  "hmos-rule-assessment",
  "hmos-human-rating-gap-analysis",
] as const;

async function ensureRequiredSkillFiles(skillsDir: string): Promise<void> {
  for (const skillName of REQUIRED_SKILL_NAMES) {
    const skillPath = path.join(skillsDir, skillName, "SKILL.md");
    await fs.access(skillPath).catch((error: unknown) => {
      throw new OpencodeConfigError(
        `缺少 opencode skill 文件：${skillName}/SKILL.md (${error instanceof Error ? error.message : String(error)})`,
      );
    });
  }
}

async function copySkillDirectory(input: {
  sourceDir: string;
  targetDir: string;
}): Promise<void> {
  await ensureRequiredSkillFiles(input.sourceDir);
  await fs.rm(input.targetDir, { recursive: true, force: true });
  await fs.mkdir(input.targetDir, { recursive: true });
  await fs.cp(input.sourceDir, input.targetDir, {
    recursive: true,
    filter: (sourcePath) => path.basename(sourcePath) !== ".DS_Store",
  });
  await ensureRequiredSkillFiles(input.targetDir);
}

async function copySharedRiskTaxonomyReference(input: {
  repoRoot: string;
  targetSkillsDir: string;
}): Promise<void> {
  const sourcePath = path.join(input.repoRoot, "references", "risks", "risk-taxonomy.yaml");
  const targetPath = path.join(
    input.targetSkillsDir,
    "hmos-rubric-scoring",
    "references",
    "risk-taxonomy.yaml",
  );
  await fs.access(sourcePath).catch((error: unknown) => {
    throw new OpencodeConfigError(
      `缺少共享 risk taxonomy 文件：references/risks/risk-taxonomy.yaml (${error instanceof Error ? error.message : String(error)})`,
    );
  });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

export async function createOpencodeRuntimeConfig(input: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  port?: number;
  runtimeName?: string;
}): Promise<OpencodeRuntimeConfig> {
  const env = input.env ?? process.env;
  const values = requiredEnv(env);
  for (const key of REQUIRED_ENV_KEYS) {
    rejectPlaceholderValue(values[key], key);
  }
  const port = input.port ?? parsePositiveInteger(values.HMOS_OPENCODE_PORT, "HMOS_OPENCODE_PORT");
  const timeoutMs = parsePositiveInteger(
    values.HMOS_OPENCODE_TIMEOUT_MS,
    "HMOS_OPENCODE_TIMEOUT_MS",
  );
  const maxOutputBytes = parsePositiveInteger(
    values.HMOS_OPENCODE_MAX_OUTPUT_BYTES,
    "HMOS_OPENCODE_MAX_OUTPUT_BYTES",
  );

  const repoRoot = path.resolve(input.repoRoot);
  const configDir = path.join(repoRoot, ".opencode");
  const runtimeRoot = env.HMOS_OPENCODE_RUNTIME_ROOT?.trim()
    ? path.resolve(env.HMOS_OPENCODE_RUNTIME_ROOT)
    : path.join(configDir, "runtime");
  const runtimeDir = input.runtimeName
    ? path.join(runtimeRoot, input.runtimeName)
    : runtimeRoot;
  const configPath = path.join(runtimeDir, "opencode.generated.json");
  const templatePath = path.join(configDir, "opencode.template.json");
  const promptsDir = path.join(configDir, "prompts");
  const formattersDir = path.join(configDir, "formatters");
  const skillsDir = path.join(configDir, "skills");

  const template = await fs.readFile(templatePath, "utf-8").catch((error: unknown) => {
    throw new OpencodeConfigError(
      `无法读取 opencode 配置模板：${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const runtimeValues: Record<RequiredEnvKey, string> = {
    ...values,
    HMOS_OPENCODE_PORT: String(port),
  };
  const generatedText = replaceTemplateVariables(template, runtimeValues);
  let generatedConfig: unknown;

  try {
    generatedConfig = applyProviderConfig(JSON.parse(generatedText) as unknown, runtimeValues);
  } catch (error) {
    throw new OpencodeConfigError(
      `生成的 opencode 配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await ensureRuntimeDirectories(runtimeDir);
  await copyFilesFromDirectory({
    sourceDir: promptsDir,
    targetDir: path.join(runtimeDir, "prompts"),
    label: "system prompt",
  });
  await copyFilesFromDirectory({
    sourceDir: promptsDir,
    targetDir: path.join(runtimeDir, "xdg-config", "opencode", "prompts"),
    label: "system prompt",
  });
  await copyFilesFromDirectory({
    sourceDir: formattersDir,
    targetDir: path.join(runtimeDir, "formatters"),
    label: "formatter",
  });
  await copyFilesFromDirectory({
    sourceDir: formattersDir,
    targetDir: path.join(runtimeDir, "xdg-config", "opencode", "formatters"),
    label: "formatter",
  });
  const runtimeSkillsDir = path.join(runtimeDir, "skills");
  const xdgSkillsDir = path.join(runtimeDir, "xdg-config", "opencode", "skills");
  await copySkillDirectory({
    sourceDir: skillsDir,
    targetDir: runtimeSkillsDir,
  });
  await copySharedRiskTaxonomyReference({
    repoRoot,
    targetSkillsDir: runtimeSkillsDir,
  });
  await copySkillDirectory({
    sourceDir: skillsDir,
    targetDir: xdgSkillsDir,
  });
  await copySharedRiskTaxonomyReference({
    repoRoot,
    targetSkillsDir: xdgSkillsDir,
  });
  const generatedConfigText = `${JSON.stringify(generatedConfig, null, 2)}\n`;
  await fs.writeFile(configPath, generatedConfigText, "utf-8");
  await fs.writeFile(
    path.join(runtimeDir, "xdg-config", "opencode", "opencode.json"),
    generatedConfigText,
    "utf-8",
  );

  const isolatedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    HOME: path.join(runtimeDir, "home"),
    XDG_CONFIG_HOME: path.join(runtimeDir, "xdg-config"),
    XDG_STATE_HOME: path.join(runtimeDir, "xdg-state"),
    XDG_DATA_HOME: path.join(runtimeDir, "xdg-data"),
    XDG_CACHE_HOME: path.join(runtimeDir, "xdg-cache"),
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: configDir,
  };

  return {
    host: values.HMOS_OPENCODE_HOST,
    port,
    serverUrl: `http://${values.HMOS_OPENCODE_HOST}:${port}`,
    configPath,
    configDir,
    runtimeDir,
    env: isolatedEnv,
    timeoutMs,
    maxOutputBytes,
  };
}
