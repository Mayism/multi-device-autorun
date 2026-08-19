import fs from "node:fs";
import path from "node:path";

export interface ArkAnalyzerCollectOptions {
  projectPath: string;
  sdkHome?: string;
  sdkPaths?: string[];
  ignoredNames?: string[];
}

interface SceneSummary {
  projectDirectory: string;
  files: SceneFileSummary[];
  viewTrees: SceneViewTreeSummary[];
}

interface SceneFileSummary {
  name: string;
  path: string;
  classes: SceneClassSummary[];
}

interface SceneClassSummary {
  name: string;
  signature?: string;
  hasViewTree: boolean;
  methods: string[];
}

interface SceneViewTreeSummary {
  component: string;
  signature?: string;
  file: string;
  nodeCount: number;
  root?: SceneViewTreeNodeSummary;
}

interface SceneViewTreeNodeSummary {
  name: string;
  kind: "system" | "custom" | "builderParam" | "unknown";
  attributes: Record<string, { uses: string[] }>;
  stateValues: string[];
  children: SceneViewTreeNodeSummary[];
  builderParam?: string;
}

interface ArkAnalyzerModule {
  Scene: new () => ArkScene;
  SceneConfig: new (options?: Record<string, unknown>) => ArkSceneConfig;
}

interface ArkSceneConfig {
  buildConfig(
    targetProjectName: string,
    targetProjectDirectory: string,
    sdks: Array<{ name: string; path: string; moduleName: string }>,
  ): void;
}

interface ArkScene {
  buildSceneFromProjectDir(config: ArkSceneConfig): void;
  inferTypes(times?: number): void;
  getFiles(): ArkFile[];
  dispose?(): void;
}

interface ArkFile {
  getName(): string;
  getFilePath(): string;
  getClasses(): ArkClass[];
}

interface ArkClass {
  getName(): string;
  getSignature?(): { toString(): string };
  getMethods(generated?: boolean): ArkMethod[];
  hasViewTree(): boolean;
  getViewTree(): ArkViewTree | undefined;
}

interface ArkMethod {
  getName(): string;
}

interface ArkViewTree {
  getRoot(): ArkViewTreeNode | null;
}

interface ArkViewTreeNode {
  name: string;
  attributes?: Map<string, [unknown, unknown[]]>;
  stateValues?: Set<{ getName(): string }>;
  children?: ArkViewTreeNode[];
  builderParam?: { getName(): string };
  walk(selector: (item: ArkViewTreeNode) => boolean): boolean;
  isBuilder?(): boolean;
  isCustomComponent?(): boolean;
}

export async function collectArkAnalyzerSceneSummary(
  options: ArkAnalyzerCollectOptions,
): Promise<SceneSummary> {
  const arkanalyzer = (await import("arkanalyzer")) as ArkAnalyzerModule;
  const config = new arkanalyzer.SceneConfig({
    supportFileExts: [".ets", ".ts"],
    ignoreFileNames: options.ignoredNames ?? ["build", ".hvigor", "oh_modules", ".preview", ".test"],
    enableBuiltIn: true,
    enableLeadingComments: true,
  });
  config.buildConfig(path.basename(options.projectPath), options.projectPath, buildSdkConfig(options));

  const scene = new arkanalyzer.Scene();
  try {
    scene.buildSceneFromProjectDir(config);
    scene.inferTypes();
    return sceneToSummary(scene, options.projectPath);
  } finally {
    scene.dispose?.();
  }
}

function sceneToSummary(scene: ArkScene, projectPath: string): SceneSummary {
  const files = scene.getFiles().map((file): SceneFileSummary => {
    const classes = file.getClasses().map((arkClass): SceneClassSummary => ({
      name: arkClass.getName(),
      signature: arkClass.getSignature?.().toString(),
      hasViewTree: arkClass.hasViewTree(),
      methods: arkClass.getMethods(true).map((method) => method.getName()),
    }));
    return {
      name: normalizeRelativePath(file.getName(), projectPath),
      path: file.getFilePath(),
      classes,
    };
  });

  const viewTrees = scene
    .getFiles()
    .flatMap((file) =>
      file
        .getClasses()
        .filter((arkClass) => arkClass.hasViewTree())
        .flatMap((arkClass): SceneViewTreeSummary[] => {
          const viewTree = arkClass.getViewTree();
          const root = viewTree?.getRoot() ?? undefined;
          const filePath = normalizeRelativePath(file.getName(), projectPath);
          return [
            {
              component: arkClass.getName(),
              signature: arkClass.getSignature?.().toString(),
              file: filePath,
              nodeCount: root ? countNodes(root) : 0,
              root: root ? viewTreeNodeToSummary(root) : undefined,
            },
          ];
        }),
    );

  return {
    projectDirectory: projectPath,
    files,
    viewTrees,
  };
}

function viewTreeNodeToSummary(node: ArkViewTreeNode): SceneViewTreeNodeSummary {
  return {
    name: node.name,
    kind: nodeKind(node),
    attributes: readAttributes(node),
    stateValues: [...(node.stateValues ?? [])].map((field) => field.getName()),
    children: (node.children ?? []).map(viewTreeNodeToSummary),
    builderParam: node.builderParam?.getName(),
  };
}

function readAttributes(node: ArkViewTreeNode): Record<string, { uses: string[] }> {
  const attributes: Record<string, { uses: string[] }> = {};
  for (const [name, [, uses]] of node.attributes ?? []) {
    attributes[name] = { uses: uses.map((item) => String(item)) };
  }
  return attributes;
}

function nodeKind(node: ArkViewTreeNode): SceneViewTreeNodeSummary["kind"] {
  if (node.builderParam) {
    return "builderParam";
  }
  if (node.isCustomComponent?.()) {
    return "custom";
  }
  if (node.isBuilder?.()) {
    return "custom";
  }
  return "system";
}

function countNodes(root: ArkViewTreeNode): number {
  let count = 0;
  root.walk(() => {
    count += 1;
    return false;
  });
  return count;
}

function buildSdkConfig(
  options: ArkAnalyzerCollectOptions,
): Array<{ name: string; path: string; moduleName: string }> {
  const sdkPaths = options.sdkPaths?.length
    ? options.sdkPaths
    : collectSdkPathsFromHome(options.sdkHome ?? process.env.HMOS_ARKANALYZER_SDK_HOME ?? process.env.OHOS_SDK_HOME);
  return sdkPaths.map((sdkPath, index) => ({
    name: index === 0 ? "etsSdk" : index === 1 ? "hmsSdk" : `sdk${index + 1}`,
    path: sdkPath,
    moduleName: "",
  }));
}

function collectSdkPathsFromHome(sdkHome: string | undefined): string[] {
  if (!sdkHome) {
    return [];
  }
  return [path.join(sdkHome, "openharmony", "ets"), path.join(sdkHome, "hms", "ets")].filter(
    (sdkPath) => fs.existsSync(sdkPath),
  );
}

function normalizeRelativePath(filePath: string, projectPath: string): string {
  const relative = path.isAbsolute(filePath) ? path.relative(projectPath, filePath) : filePath;
  return relative.replace(/\\/g, "/").replace(/^\/+/, "");
}
