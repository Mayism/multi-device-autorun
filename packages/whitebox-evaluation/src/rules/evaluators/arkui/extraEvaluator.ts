import type { RegisteredRule } from "../../types/ruleTypes.js";
import type { CollectedEvidence, WorkspaceFile } from "../../evidence/types.js";
import type { EvaluatedRule } from "../shared.js";

type RouteMapEntry = {
  pageSourceFile?: unknown;
};

type RouteMapDocument = {
  routerMap?: unknown;
};

function baseResult(
  rule: RegisteredRule,
  result: EvaluatedRule["result"],
  conclusion: string,
): EvaluatedRule {
  return {
    rule_id: rule.rule_id,
    rule_source: rule.rule_source,
    result,
    conclusion,
    matchedFiles: [],
  };
}

function allWorkspaceFiles(evidence: CollectedEvidence): WorkspaceFile[] {
  return evidence.allWorkspaceFiles ?? evidence.workspaceFiles;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath
    .replace(/^workspace\//, "")
    .replace(/^generated\//, "")
    .replace(/\\/g, "/");
}

function findFile(files: WorkspaceFile[], relativePath: string): WorkspaceFile | undefined {
  const normalizedPath = normalizeRelativePath(relativePath);
  return files.find((file) => normalizeRelativePath(file.relativePath) === normalizedPath);
}

function extractRouterMapProfile(moduleJsonContent: string): string | undefined {
  const match = /(?:^|[,{]\s*)["']?routerMap["']?\s*:\s*["']\$profile:([^"']+)["']/.exec(
    moduleJsonContent,
  );
  return match?.[1]?.trim();
}

function moduleRootFromModuleJsonPath(relativePath: string): string {
  const marker = "/src/main/module.json5";
  const normalizedPath = normalizeRelativePath(relativePath);
  return normalizedPath.endsWith(marker) ? normalizedPath.slice(0, -marker.length) : "";
}

function profilePathForModule(moduleJsonPath: string, profileName: string): string {
  const moduleRoot = moduleRootFromModuleJsonPath(moduleJsonPath);
  const prefix = moduleRoot ? `${moduleRoot}/` : "";
  return `${prefix}src/main/resources/base/profile/${profileName}.json`;
}

function parseRouteMap(content: string): RouteMapEntry[] | undefined {
  try {
    const parsed = JSON.parse(content) as RouteMapDocument;
    if (!Array.isArray(parsed.routerMap)) {
      return [];
    }
    return parsed.routerMap.filter(
      (item): item is RouteMapEntry => Boolean(item) && typeof item === "object",
    );
  } catch {
    return undefined;
  }
}

function normalizePageSourceFile(moduleJsonPath: string, pageSourceFile: string): string {
  const normalizedPage = normalizeRelativePath(pageSourceFile).replace(/^\/+/, "");
  const moduleRoot = moduleRootFromModuleJsonPath(moduleJsonPath);
  const pageWithExtension = normalizedPage.endsWith(".ets")
    ? normalizedPage
    : `${normalizedPage}.ets`;
  if (normalizedPage.startsWith("src/main/")) {
    return `${moduleRoot ? `${moduleRoot}/` : ""}${pageWithExtension}`;
  }
  if (moduleRoot && !normalizedPage.startsWith(`${moduleRoot}/`)) {
    return `${moduleRoot}/${pageWithExtension}`;
  }
  return pageWithExtension;
}

function hasNavDestination(content: string): boolean {
  return /\bNavDestination\s*\(/.test(content);
}

function routeTargetsMentionedByPatch(
  evidence: CollectedEvidence,
  moduleJsonPath: string,
  profilePath: string,
): Set<string> {
  const addedTargets = new Set<string>();
  const removedTargets = new Set<string>();
  const patchText = evidence.patchText;
  if (!patchText) {
    return addedTargets;
  }

  let currentFile: string | undefined;
  for (const line of patchText.split(/\r?\n/)) {
    const diffMatch = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (diffMatch?.[1]) {
      currentFile = normalizeRelativePath(diffMatch[1]);
      continue;
    }

    const newFileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (newFileMatch?.[1]) {
      currentFile = normalizeRelativePath(newFileMatch[1]);
      continue;
    }

    if (currentFile !== normalizeRelativePath(profilePath)) {
      continue;
    }

    const isAddedLine = line.startsWith("+") && !line.startsWith("+++");
    const isRemovedLine = line.startsWith("-") && !line.startsWith("---");
    if (!isAddedLine && !isRemovedLine) {
      continue;
    }

    for (const match of line.matchAll(/["']pageSourceFile["']\s*:\s*["']([^"']+)["']/g)) {
      const normalizedTarget = normalizePageSourceFile(moduleJsonPath, match[1] ?? "");
      if (isAddedLine) {
        addedTargets.add(normalizedTarget);
      } else {
        removedTargets.add(normalizedTarget);
      }
    }
  }

  for (const removedTarget of removedTargets) {
    addedTargets.delete(removedTarget);
  }
  return addedTargets;
}

function shouldInspectRouteTarget(
  evidence: CollectedEvidence,
  moduleJsonPath: string,
  profilePath: string,
  pagePath: string,
  patchAddedRouteTargets: Set<string>,
): boolean {
  const changedFiles = new Set(evidence.changedFiles.map(normalizeRelativePath));
  if (changedFiles.size === 0) {
    return true;
  }

  const normalizedPagePath = normalizeRelativePath(pagePath);
  if (changedFiles.has(normalizedPagePath)) {
    return true;
  }

  return (
    changedFiles.has(normalizeRelativePath(moduleJsonPath)) ||
    patchAddedRouteTargets.has(normalizedPagePath)
  );
}

function runRouteNavDestinationRule(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const files = allWorkspaceFiles(evidence);
  const moduleFiles = files.filter((file) =>
    normalizeRelativePath(file.relativePath).endsWith("/src/main/module.json5"),
  );
  const modulesWithRouterMap = moduleFiles.flatMap((file) => {
    const profileName = extractRouterMapProfile(file.content);
    return profileName ? [{ file, profileName }] : [];
  });

  if (modulesWithRouterMap.length === 0) {
    return baseResult(rule, "不涉及", "工程未配置 routerMap，规则不涉及。");
  }

  const missingOrInvalidProfiles: string[] = [];
  const failedPages: string[] = [];
  const inspectedPages: string[] = [];

  for (const item of modulesWithRouterMap) {
    const profilePath = profilePathForModule(item.file.relativePath, item.profileName);
    const profileFile = findFile(files, profilePath);
    if (!profileFile) {
      missingOrInvalidProfiles.push(profilePath);
      continue;
    }

    const routeEntries = parseRouteMap(profileFile.content);
    if (!routeEntries) {
      missingOrInvalidProfiles.push(profilePath);
      continue;
    }

    const patchAddedRouteTargets = routeTargetsMentionedByPatch(
      evidence,
      item.file.relativePath,
      profilePath,
    );
    for (const routeEntry of routeEntries) {
      if (typeof routeEntry.pageSourceFile !== "string") {
        continue;
      }
      const pagePath = normalizePageSourceFile(item.file.relativePath, routeEntry.pageSourceFile);
      if (
        !shouldInspectRouteTarget(
          evidence,
          item.file.relativePath,
          profilePath,
          pagePath,
          patchAddedRouteTargets,
        )
      ) {
        continue;
      }
      inspectedPages.push(pagePath);
      const pageFile = findFile(files, pagePath);
      if (!pageFile || !hasNavDestination(pageFile.content)) {
        failedPages.push(pagePath);
      }
    }
  }

  if (missingOrInvalidProfiles.length > 0) {
    return {
      ...baseResult(
        rule,
        "不满足",
        `配置了 routerMap，但 profile 缺失或不可读：${missingOrInvalidProfiles.join(", ")}。`,
      ),
      matchedFiles: missingOrInvalidProfiles,
    };
  }

  if (failedPages.length > 0) {
    return {
      ...baseResult(
        rule,
        "不满足",
        `routerMap 指向的页面未使用 NavDestination：${failedPages.join(", ")}。`,
      ),
      matchedFiles: failedPages,
    };
  }

  if (inspectedPages.length === 0) {
    return baseResult(rule, "不涉及", "本次变更未涉及 routerMap 配置或其指向页面。");
  }

  return {
    ...baseResult(rule, "满足", "routerMap 指向页面均使用 NavDestination。"),
    matchedFiles: inspectedPages,
  };
}

function stripCommentsAndStrings(content: string): string {
  let output = "";
  let index = 0;
  let mode: "code" | "line_comment" | "block_comment" | "single" | "double" | "template" = "code";

  while (index < content.length) {
    const current = content[index] ?? "";
    const next = content[index + 1] ?? "";

    if (mode === "line_comment") {
      if (current === "\n") {
        mode = "code";
        output += "\n";
      } else {
        output += " ";
      }
      index += 1;
      continue;
    }

    if (mode === "block_comment") {
      if (current === "*" && next === "/") {
        output += "  ";
        mode = "code";
        index += 2;
      } else {
        output += current === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (mode === "single" || mode === "double" || mode === "template") {
      const quote = mode === "single" ? "'" : mode === "double" ? '"' : "`";
      if (current === "\\") {
        output += "  ";
        index += 2;
        continue;
      }
      if (current === quote) {
        mode = "code";
      }
      output += current === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (current === "/" && next === "/") {
      mode = "line_comment";
      output += "  ";
      index += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      mode = "block_comment";
      output += "  ";
      index += 2;
      continue;
    }
    if (current === "'") {
      mode = "single";
      output += " ";
      index += 1;
      continue;
    }
    if (current === '"') {
      mode = "double";
      output += " ";
      index += 1;
      continue;
    }
    if (current === "`") {
      mode = "template";
      output += " ";
      index += 1;
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}

function findMultipleBindSheetLocations(file: WorkspaceFile): string[] {
  const sanitized = stripCommentsAndStrings(file.content);
  const locations: string[] = [];
  let currentChainHasBindSheet = false;

  for (const [index, line] of sanitized.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const isModifierContinuation = trimmed.startsWith(".");
    if (!isModifierContinuation) {
      currentChainHasBindSheet = false;
    }

    const bindSheetMatches = [...line.matchAll(/\.\s*bindSheet\s*\(/g)];
    if (bindSheetMatches.length === 0) {
      continue;
    }

    if (currentChainHasBindSheet || bindSheetMatches.length > 1) {
      locations.push(`${file.relativePath}:${index + 1}`);
    }
    currentChainHasBindSheet = true;
  }

  return locations;
}

function runMultiBindSheetRule(rule: RegisteredRule, evidence: CollectedEvidence): EvaluatedRule {
  const locations = evidence.workspaceFiles
    .filter((file) => file.relativePath.endsWith(".ets"))
    .flatMap(findMultipleBindSheetLocations);

  if (locations.length > 0) {
    return {
      ...baseResult(
        rule,
        "不满足",
        `同一组件链式调用了多个 bindSheet：${locations.slice(0, 5).join(", ")}。`,
      ),
      matchedFiles: [...new Set(locations.map((location) => location.replace(/:\d+$/, "")))],
      matchedLocations: locations,
    };
  }

  const hasBindSheet = evidence.workspaceFiles.some(
    (file) =>
      file.relativePath.endsWith(".ets") &&
      /\bbindSheet\s*\(/.test(stripCommentsAndStrings(file.content)),
  );
  if (!hasBindSheet) {
    return baseResult(rule, "不涉及", "本次变更未涉及 bindSheet。");
  }

  return baseResult(rule, "满足", "未发现同一组件链式调用多个 bindSheet。");
}

export function runArkuiExtraRule(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const check = rule.detector.config.check;
  if (check === "route_navdestination") {
    return runRouteNavDestinationRule(rule, evidence);
  }
  if (check === "multi_bindsheet_same_component") {
    return runMultiBindSheetRule(rule, evidence);
  }

  return baseResult(
    rule,
    "未接入判定器",
    `${rule.summary} 当前版本未接入静态判定器，需要 Agent 辅助判定。`,
  );
}
