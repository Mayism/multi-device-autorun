import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adaptArkAnalyzerScene } from "./adapter.js";
import { collectArkAnalyzerSceneSummary } from "./collector.js";
import { writeArkFactsDebugArtifacts } from "./debugWriter.js";
import type { ArkFactsIndex } from "./types.js";
import type { CollectedEvidence } from "../evidence/types.js";

const execFileAsync = promisify(execFile);

export interface ArkAnalyzerFactsOptions {
  projectPath: string;
  caseDir?: string;
  fixtureScene?: unknown;
  analyzerHome?: string;
  analyzerScriptPath?: string;
  sdkHome?: string;
  sdkPaths?: string[];
  timeoutMs?: number;
  ignoredNames?: string[];
  skipExternalExecution?: boolean;
}

const evidenceCache = new WeakMap<CollectedEvidence, Promise<ArkFactsIndex>>();
const projectCache = new Map<string, Promise<ArkFactsIndex>>();

export async function getArkFactsForEvidence(
  evidence: CollectedEvidence,
  options: ArkAnalyzerFactsOptions,
): Promise<ArkFactsIndex> {
  const cached = evidenceCache.get(evidence);
  if (cached) {
    return cached;
  }
  const promise = runArkAnalyzerFacts(options);
  evidenceCache.set(evidence, promise);
  return promise;
}

export async function getArkFactsForProject(
  options: ArkAnalyzerFactsOptions,
): Promise<ArkFactsIndex> {
  if (options.fixtureScene !== undefined) {
    return runArkAnalyzerFacts(options);
  }
  const cacheKey = buildProjectCacheKey(options);
  const cached = projectCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const promise = runArkAnalyzerFacts(options);
  projectCache.set(cacheKey, promise);
  return promise;
}

function buildProjectCacheKey(options: ArkAnalyzerFactsOptions): string {
  return JSON.stringify({
    projectPath: options.projectPath,
    caseDir: options.caseDir ?? "",
    fixtureScene: options.fixtureScene !== undefined,
    analyzerHome: options.analyzerHome ?? "",
    analyzerScriptPath: options.analyzerScriptPath ?? "",
    sdkHome: options.sdkHome ?? "",
    sdkPaths: options.sdkPaths ?? [],
    ignoredNames: options.ignoredNames ?? [],
  });
}

export async function runArkAnalyzerFacts(options: ArkAnalyzerFactsOptions): Promise<ArkFactsIndex> {
  if (options.fixtureScene !== undefined) {
    return adaptAndWrite(options.fixtureScene, options);
  }
  if (options.skipExternalExecution !== false) {
    return unavailableFacts("ARKANALYZER_NOT_CONFIGURED", "ArkAnalyzer external execution is not configured.", options);
  }

  try {
    if (options.analyzerScriptPath || options.analyzerHome) {
      return await runAnalyzerScript(options);
    }
    const scene = await collectArkAnalyzerSceneSummary(options);
    return adaptAndWrite(scene, options);
  } catch (error) {
    return unavailableFacts(
      "ARKANALYZER_EXECUTION_FAILED",
      error instanceof Error ? error.message : "ArkAnalyzer execution failed.",
      options,
    );
  }
}

async function runAnalyzerScript(options: ArkAnalyzerFactsOptions): Promise<ArkFactsIndex> {
  const parseScript =
    options.analyzerScriptPath ??
    (options.analyzerHome
      ? path.join(options.analyzerHome, "tools", "arkanalyzer", "parse-project.js")
      : undefined);
  if (!parseScript || !(await fileExists(parseScript))) {
    return unavailableFacts("ARKANALYZER_UNAVAILABLE", "ArkAnalyzer parse-project.js was not found.", options);
  }
  try {
    const outputDir = options.caseDir
      ? path.join(options.caseDir, "intermediate", "arkanalyzer")
      : path.join(options.projectPath, ".hmos-arkanalyzer");
    await fs.mkdir(outputDir, { recursive: true });
    const configPath = path.join(outputDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify(buildAnalyzerConfig(options), null, 2), "utf-8");
    await execFileAsync(process.execPath, [parseScript, configPath, outputDir], {
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const scenePath = path.join(outputDir, "scene-summary.json");
    const scene = JSON.parse(await fs.readFile(scenePath, "utf-8")) as unknown;
    return adaptAndWrite(scene, options);
  } catch (error) {
    return unavailableFacts(
      "ARKANALYZER_EXECUTION_FAILED",
      error instanceof Error ? error.message : "ArkAnalyzer execution failed.",
      options,
    );
  }
}

function buildAnalyzerConfig(options: ArkAnalyzerFactsOptions): Record<string, unknown> {
  const sdkPaths = options.sdkPaths?.length
    ? options.sdkPaths
    : collectSdkPathsFromHome(options.sdkHome ?? process.env.HMOS_ARKANALYZER_SDK_HOME ?? process.env.OHOS_SDK_HOME);
  return {
    targetProjectName: path.basename(options.projectPath),
    targetProjectDirectory: options.projectPath,
    sdks: sdkPaths.map((sdkPath, index) => ({
      name: index === 0 ? "etsSdk" : index === 1 ? "hmsSdk" : `sdk${index + 1}`,
      path: sdkPath,
      moduleName: "",
    })),
    options: {
      supportFileExts: [".ets", ".ts"],
      ignoreFileNames: options.ignoredNames ?? ["build", ".hvigor", "oh_modules", ".preview", ".test"],
      enableBuiltIn: true,
      enableLeadingComments: true,
    },
  };
}

function collectSdkPathsFromHome(sdkHome: string | undefined): string[] {
  if (!sdkHome) {
    return [];
  }
  return [path.join(sdkHome, "openharmony", "ets"), path.join(sdkHome, "hms", "ets")].filter(
    (sdkPath) => fsSync.existsSync(sdkPath),
  );
}

async function adaptAndWrite(scene: unknown, options: ArkAnalyzerFactsOptions): Promise<ArkFactsIndex> {
  const facts = adaptArkAnalyzerScene(scene);
  await writeArkFactsDebugArtifacts({ caseDir: options.caseDir, scene, facts });
  return facts;
}

async function unavailableFacts(
  code: string,
  message: string,
  options: ArkAnalyzerFactsOptions,
): Promise<ArkFactsIndex> {
  const facts: ArkFactsIndex = {
    files: [],
    declarations: [],
    methods: [],
    viewTrees: [],
    components: [],
    diagnostics: [{ code, message, severity: "error" }],
  };
  await writeArkFactsDebugArtifacts({ caseDir: options.caseDir, scene: {}, facts });
  return facts;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
