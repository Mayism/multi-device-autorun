import fs from "node:fs";
import path from "node:path";
import type { RegisteredRule } from "../../types/ruleTypes.js";
import type { CollectedEvidence } from "../../evidence/types.js";
import type { EvaluatedRule } from "../shared.js";
import {
  ArkuiComponentInstance,
  ArkuiStaticScanIndex,
  buildArkuiStaticScanIndex,
} from "./staticScanner.js";
import { buildArkuiStaticScanIndexFromArkFacts } from "./astFacts.js";
import {
  ARKUI_RULE_SPEC_BY_CHECK,
  MANUAL_APPLICABILITY_CHECKS,
  TEXT_STATIC_CHECKS,
  type ArkuiRuleSpec,
} from "./ruleSpecs.js";

type PropertyValue = {
  name: string;
  valueText: string;
  line: number;
  usesBreakpoint: boolean;
};

const scanIndexCache = new WeakMap<CollectedEvidence, ArkuiStaticScanIndex>();
const ruleTraceCache = new WeakMap<CollectedEvidence, Array<Record<string, unknown>>>();
const patchScopedFileSetCache = new WeakMap<CollectedEvidence, Set<string>>();

export function runArkuiStaticRule(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const check =
    typeof rule.detector.config.check === "string" ? rule.detector.config.check : undefined;
  const spec = check ? ARKUI_RULE_SPEC_BY_CHECK.get(check) : undefined;
  if (check && TEXT_STATIC_CHECKS.has(check)) {
    const scanIndex = getScanIndex(evidence);
    const result = runTextStaticCheck(rule, check, evidence, scanIndex);
    writeDebugArtifacts(evidence, rule, result, scanIndex);
    return result;
  }
  if (!spec) {
    const result = baseResult(rule, "未接入判定器", `${rule.summary} 未注册 ArkUI 静态检查项。`, {
      check,
    });
    writeDebugArtifacts(evidence, rule, result);
    return result;
  }

  const scanIndex = getScanIndex(evidence);
  if (MANUAL_APPLICABILITY_CHECKS.has(spec.check)) {
    const instances = getPatchScopedComponentInstances(evidence, scanIndex).filter(
      (item) => item.component === spec.component,
    );
    if (instances.length === 0) {
      const result = baseResult(rule, "不涉及", `未发现 ${spec.component} 组件，规则不涉及。`, {
        check: spec.check,
        component: spec.component,
        inspectedComponentCount: 0,
      });
      writeDebugArtifacts(evidence, rule, result, scanIndex);
      return result;
    }
    const reviewInstances = instances.slice(0, 5);
    const result = withMatches(
      baseResult(
        rule,
        "未接入判定器",
        `${spec.component} ${spec.properties.join("/")} 的适用场景依赖布局意图，当前静态扫描提供组件源码片段，需要 Agent 复核。`,
        {
          check: spec.check,
          component: spec.component,
          properties: spec.properties,
          requirement: spec.requirement,
          inspectedComponentCount: instances.length,
          reviewEvidence: buildManualReviewEvidence(spec, reviewInstances, evidence),
        },
      ),
      reviewInstances.map((instance) => ({ file: instance.filePath, line: instance.line })),
      reviewInstances.map((instance) => buildManualReviewSnippet(instance, spec, evidence)),
    );
    writeDebugArtifacts(evidence, rule, result, scanIndex);
    return result;
  }

  const instances = getPatchScopedComponentInstances(evidence, scanIndex).filter(
    (item) => item.component === spec.component,
  );
  if (instances.length === 0) {
    const result = baseResult(rule, "不涉及", `未发现 ${spec.component} 组件，规则不涉及。`, {
      check: spec.check,
      component: spec.component,
      inspectedComponentCount: 0,
    });
    writeDebugArtifacts(evidence, rule, result, scanIndex);
    return result;
  }

  const applicableInstances = instances.filter((instance) =>
    isInstanceApplicable(instance, spec, scanIndex),
  );
  if (applicableInstances.length === 0) {
    const result = baseResult(
      rule,
      "不涉及",
      `${spec.component} 未发现需要检查的 ${spec.properties.join("/")} 配置，规则不涉及。`,
      {
        ...buildPreliminaryData(spec, instances),
        applicableComponentCount: 0,
      },
    );
    writeDebugArtifacts(evidence, rule, result, scanIndex);
    return result;
  }

  const reviewInstances = applicableInstances.filter((instance) =>
    shouldDeferInstanceToAgent(instance, spec, scanIndex),
  );
  const failedInstances = applicableInstances.filter(
    (instance) =>
      !reviewInstances.includes(instance) && !isInstanceSatisfied(instance, spec, scanIndex),
  );
  if (failedInstances.length > 0) {
    const result = withMatches(
      baseResult(
        rule,
        "不满足",
        `${spec.component} ${spec.properties.join("/")} 未满足 ${describeRequirement(spec)}。`,
        buildPreliminaryData(spec, applicableInstances),
      ),
      failedInstances.map((instance) => ({ file: instance.filePath, line: instance.line })),
      failedInstances.map((instance) => buildInstanceSnippet(instance, spec)),
    );
    writeDebugArtifacts(evidence, rule, result, scanIndex);
    return result;
  }
  if (reviewInstances.length > 0) {
    const result = withMatches(
      baseResult(
        rule,
        "未接入判定器",
        `${spec.component} ${spec.properties.join("/")} 使用静态层无法稳定解释的封装表达式，需要 Agent 复核。`,
        {
          ...buildPreliminaryData(spec, reviewInstances),
          reviewEvidence: buildReviewEvidence(spec, reviewInstances),
        },
      ),
      reviewInstances.map((instance) => ({ file: instance.filePath, line: instance.line })),
      reviewInstances.map((instance) => buildPropertySnippet(instance, spec)),
    );
    writeDebugArtifacts(evidence, rule, result, scanIndex);
    return result;
  }

  const result = {
    ...baseResult(
      rule,
      "满足",
      `${spec.component} ${spec.properties.join("/")} 均满足 ${describeRequirement(spec)}。`,
      buildPreliminaryData(spec, applicableInstances),
    ),
    matchedFiles: unique(applicableInstances.map((instance) => instance.filePath)),
    matchedLocations: applicableInstances.map(
      (instance) => `${instance.filePath}:${instance.line}`,
    ),
  };
  writeDebugArtifacts(evidence, rule, result, scanIndex);
  return result;
}

function runTextStaticCheck(
  rule: RegisteredRule,
  check: string,
  evidence: CollectedEvidence,
  scanIndex: ArkuiStaticScanIndex,
): EvaluatedRule {
  if (check === "module_device_types_multi_device") {
    return checkModuleDeviceTypes(rule, evidence);
  }
  if (check === "breakpoint_ranges_standard") {
    return checkBreakpointRanges(rule, evidence, scanIndex);
  }
  if (check === "breakpoint_no_hardcoded_width") {
    return checkHardcodedBreakpointWidth(rule, evidence);
  }
  if (check === "breakpoint_source_standard") {
    return checkBreakpointSource(rule, evidence);
  }
  if (check === "breakpoint_listener_source_standard") {
    return checkBreakpointListenerSource(rule, evidence);
  }
  if (check === "breakpoint_listener_after_load_content") {
    return checkBreakpointListenerTiming(rule, evidence);
  }
  if (check === "folderstack_fullscreen") {
    return checkFolderStackFullscreen(rule, scanIndex);
  }
  if (check === "folderstack_upper_items_ids") {
    return checkFolderStackUpperItemIds(rule, scanIndex);
  }
  if (check === "custom_hover_fold_and_landscape") {
    return checkCustomHoverFoldAndLandscape(rule, evidence);
  }
  if (check === "custom_hover_crease_region_api") {
    return checkCustomHoverCreaseRegionApi(rule, evidence);
  }
  if (check === "custom_hover_fold_listener_cleanup") {
    return checkCustomHoverFoldListenerCleanup(rule, evidence);
  }
  if (check === "web_container_size_by_breakpoint") {
    return checkWebContainerSize(rule, scanIndex);
  }
  if (check === "web_breakpoint_sync_source") {
    return checkWebBreakpointSyncSource(rule, evidence, scanIndex);
  }
  if (check === "web_media_query_breakpoints_standard") {
    return checkWebMediaQueryBreakpoints(rule, evidence);
  }
  if (check === "web_vertical_breakpoint_aspect_ratio") {
    return checkWebVerticalBreakpoint(rule, evidence);
  }
  if (check === "gridrow_no_dynamic_constraint_size_centering") {
    return checkDynamicConstraintSize(rule, evidence, scanIndex);
  }
  if (check === "aspect_ratio_by_breakpoint") {
    return checkAspectRatioByBreakpoint(rule, scanIndex);
  }
  return baseResult(rule, "未接入判定器", `${rule.summary} 未注册静态检查项。`, { check });
}

function checkModuleDeviceTypes(rule: RegisteredRule, evidence: CollectedEvidence): EvaluatedRule {
  const files = getAllFiles(evidence)
    .filter((file) => /(^|\/)src\/main\/module\.json5$/.test(file.relativePath))
    .filter((file) => isHapModule(file.content));
  if (files.length === 0) {
    return baseResult(rule, "不涉及", "未发现 HAP 模块的 src/main/module.json5，规则不涉及。");
  }

  const deviceTypesByFile = files.map((file) => ({
    file,
    deviceTypes: readStringArrayProperty(file.content, "deviceTypes"),
  }));
  const aggregatedDeviceTypes = unique(
    deviceTypesByFile.flatMap((item) => item.deviceTypes),
  ).sort();
  if (!aggregatedDeviceTypes.includes("phone") || !aggregatedDeviceTypes.includes("tablet")) {
    return withMatches(
      baseResult(rule, "不满足", "工程 HAP 模块 deviceTypes 汇总后缺少 phone 或 tablet。", {
        inspectedFileCount: files.length,
        aggregatedDeviceTypes,
      }),
      files.map((file) => ({
        file: file.relativePath,
        line: lineOfPattern(file.content, "deviceTypes"),
      })),
      [`aggregatedDeviceTypes=${aggregatedDeviceTypes.join(",")}`],
    );
  }
  return withMatches(
    baseResult(rule, "满足", "工程 HAP 模块 deviceTypes 汇总后包含 phone 和 tablet。", {
      inspectedFileCount: files.length,
      aggregatedDeviceTypes,
    }),
    files.map((file) => ({
      file: file.relativePath,
      line: lineOfPattern(file.content, "deviceTypes"),
    })),
    deviceTypesByFile.map((item) => `deviceTypes=${item.deviceTypes.join(",")}`),
  );
}

function checkBreakpointRanges(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
  scanIndex: ArkuiStaticScanIndex,
): EvaluatedRule {
  const gridRows = scanIndex.componentInstances.filter(
    (instance) => instance.component === "GridRow" && isPatchScopedInstance(evidence, instance),
  );
  const gridRowBreakpoints = gridRows.flatMap((instance) => {
    const value = readPropertyValue(instance, "breakpoints");
    return value ? [{ instance, value }] : [];
  });
  const opaqueGridRows = gridRowBreakpoints.filter(({ value }) =>
    isOpaqueResponsiveExpression(value.valueText, scanIndex),
  );
  const failedGridRows = gridRowBreakpoints.filter(
    ({ value }) =>
      !isOpaqueResponsiveExpression(value.valueText, scanIndex) &&
      !["320vp", "600vp", "840vp", "1440vp"].every((text) =>
        resolveConstants(value.valueText, scanIndex).includes(text),
      ),
  );
  const files = getEtsFiles(evidence);
  const badRangeMatches = findPatternMatches(
    files,
    /\b(?:xs|sm|md|lg|xl)\b[^;\n]{0,80}\b(300|500|768|800|900|1200|1280|1600)\b/g,
  ).filter((match) => !/register/i.test(match.snippet ?? ""));

  if (failedGridRows.length > 0 || badRangeMatches.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "断点边界未覆盖系统推荐值 320/600/840/1440。", {
        inspectedGridRowBreakpointCount: gridRowBreakpoints.length,
      }),
      [
        ...failedGridRows.map(({ instance }) => ({ file: instance.filePath, line: instance.line })),
        ...badRangeMatches,
      ],
      [
        ...failedGridRows.map(({ value }) => `breakpoints=${value.valueText}`),
        ...snippetsOf(badRangeMatches),
      ],
    );
  }
  if (opaqueGridRows.length > 0) {
    return withMatches(
      baseResult(rule, "未接入判定器", "GridRow breakpoints 使用静态层无法稳定解释的封装表达式，需要 Agent 复核。", {
        inspectedGridRowBreakpointCount: gridRowBreakpoints.length,
        reviewEvidence: opaqueGridRows.map(({ instance, value }) => ({
          rule_id: "breakpoint_ranges_standard",
          file: instance.filePath,
          line: value.line ?? instance.line,
          subject: instance.component,
          evidence: `breakpoints=${value.valueText}`,
          question: "请结合规则描述和源码上下文复核该 GridRow breakpoints 是否包含推荐断点 320vp/600vp/840vp/1440vp。",
        })),
      }),
      opaqueGridRows.map(({ instance, value }) => ({
        file: instance.filePath,
        line: value.line ?? instance.line,
      })),
      opaqueGridRows.map(({ value }) => `breakpoints=${value.valueText}`),
    );
  }
  if (gridRowBreakpoints.length === 0 && badRangeMatches.length === 0) {
    return baseResult(
      rule,
      "不涉及",
      "未发现自定义断点边界或 GridRow breakpoints 配置，规则不涉及。",
    );
  }
  return withMatches(
    baseResult(rule, "满足", "断点边界符合系统推荐值。", {
      inspectedGridRowBreakpointCount: gridRowBreakpoints.length,
    }),
    gridRowBreakpoints.map(({ instance }) => ({ file: instance.filePath, line: instance.line })),
  );
}

function checkHardcodedBreakpointWidth(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const matches = findPatternMatches(
    getEtsFiles(evidence),
    /\b(?:screenWidth|windowWidth|contentWidth|width|vp)\b\s*(?:[<>]=?|===?)\s*(?:320|600|840|1440)\b|\b(?:320|600|840|1440)\b\s*(?:[<>]=?|===?)\s*\b(?:screenWidth|windowWidth|contentWidth|width|vp)\b/g,
  ).filter((match) => !/BreakpointSystem\.register|breakpoints\s*:/.test(match.snippet ?? ""));
  if (matches.length === 0) {
    return baseResult(rule, "满足", "未发现布局条件中使用硬编码断点宽度比较。");
  }
  return withMatches(
    baseResult(rule, "不满足", "发现布局条件使用硬编码断点宽度比较。"),
    matches,
    snippetsOf(matches),
  );
}

function checkBreakpointSource(rule: RegisteredRule, evidence: CollectedEvidence): EvaluatedRule {
  const badMatches = findPatternMatches(
    getEtsFiles(evidence),
    /\bonAreaChange\s*\([^)]*=>[\s\S]{0,300}\b(?:width|contentWidth)\b[\s\S]{0,120}\b(?:320|600|840|1440)\b|\bcalcBreakpoint\s*\([^)]*\)[\s\S]{0,240}\b(?:320|600|840|1440)\b|\b(?:currentBreakpoint|breakpoint)\b[\s\S]{0,160}\b(?:width|screenWidth|windowWidth|contentWidth)\b\s*(?:[<>]=?|===?)\s*(?:320|600|840|1440)\b|\b(?:width|screenWidth|windowWidth|contentWidth)\b\s*(?:[<>]=?|===?)\s*(?:320|600|840|1440)\b[\s\S]{0,160}\b(?:currentBreakpoint|breakpoint)\b/gi,
  );
  if (badMatches.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "发现通过组件宽度、窗口宽度或硬编码阈值推导当前断点。"),
      badMatches,
      snippetsOf(badMatches),
    );
  }
  const goodMatches = findPatternMatches(
    getEtsFiles(evidence),
    /\b(?:WidthBreakpoint|currentBreakpoint|mediaquery|windowSizeChange|GridRow\s*\([^)]*breakpoints)/g,
  );
  if (goodMatches.length === 0) {
    return baseResult(rule, "不涉及", "未发现页面组件获取当前断点值的代码，规则不涉及。");
  }
  return withMatches(
    baseResult(rule, "满足", "断点来源使用系统断点、mediaquery、窗口监听或标准 GridRow。"),
    goodMatches.slice(0, 10),
  );
}

function checkBreakpointListenerSource(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const files = getEtsFiles(evidence);
  const badMatches = findPatternMatches(files, /\b(?:foldStatusChange|orientation)\b/g).filter(
    (match) =>
      /breakpoint|WidthBreakpoint|screenWidth|windowWidth|currentBreakpoint/i.test(
        match.snippet ?? "",
      ),
  );
  if (badMatches.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "发现使用 foldStatusChange 或方向 API 驱动断点更新。"),
      badMatches,
      snippetsOf(badMatches),
    );
  }
  const goodMatches = findPatternMatches(
    files,
    /\b(?:windowSizeChange|mediaquery\.matchMediaSync|display\.on\s*\(\s*['"]change['"])/g,
  );
  if (goodMatches.length === 0) {
    return baseResult(rule, "不涉及", "未发现断点监听注册，规则不涉及。");
  }
  return withMatches(
    baseResult(rule, "满足", "断点监听来源使用 windowSizeChange、mediaquery 或 display change。"),
    goodMatches.slice(0, 10),
  );
}

function checkBreakpointListenerTiming(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const files = getEtsFiles(evidence);
  const listenerMatches = findPatternMatches(
    files,
    /\b(?:windowSizeChange|mediaquery\.matchMediaSync)\b/g,
  );
  if (listenerMatches.length === 0) {
    return baseResult(
      rule,
      "不涉及",
      "未发现 windowSizeChange 或 mediaquery 断点监听，规则不涉及。",
    );
  }
  const badMatches = findPatternMatches(
    files,
    /\bon(?:Create|WindowStageCreate)\s*\([^)]*\)\s*\{[\s\S]{0,500}\b(?:windowSizeChange|mediaquery\.matchMediaSync)\b[\s\S]{0,500}\bloadContent\b/g,
  );
  if (badMatches.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "发现断点监听在 loadContent 完成前注册。"),
      badMatches,
      snippetsOf(badMatches),
    );
  }
  const goodMatches = findPatternMatches(
    files,
    /\b(?:loadContent\s*\([^)]*,\s*\([^)]*\)\s*=>[\s\S]{0,300}(?:windowSizeChange|mediaquery\.matchMediaSync)|aboutToAppear\s*\([^)]*\)\s*\{[\s\S]{0,300}(?:windowSizeChange|mediaquery\.matchMediaSync))/g,
  );
  if (goodMatches.length > 0) {
    return withMatches(
      baseResult(rule, "满足", "断点监听在 loadContent 回调或页面 aboutToAppear 中注册。"),
      goodMatches.slice(0, 10),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "未发现断点监听早于 loadContent 注册的反模式。"),
    listenerMatches.slice(0, 10),
  );
}

function checkFolderStackFullscreen(
  rule: RegisteredRule,
  scanIndex: ArkuiStaticScanIndex,
): EvaluatedRule {
  const instances = scanIndex.componentInstances.filter(
    (instance) => instance.component === "FolderStack",
  );
  if (instances.length === 0) {
    return baseResult(rule, "不涉及", "未发现 FolderStack，规则不涉及。");
  }
  const failed = instances.filter((instance) => {
    const width = readPropertyValue(instance, "width")?.valueText;
    const height = readPropertyValue(instance, "height")?.valueText;
    const hasExpandSafeArea = Boolean(readPropertyValue(instance, "expandSafeArea"));
    return !(hasExpandSafeArea || (isFullSize(width) && isFullSize(height)));
  });
  if (failed.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "FolderStack 未显式撑满全屏。"),
      failed.map((instance) => ({ file: instance.filePath, line: instance.line })),
      failed.map((instance) =>
        buildInstanceSnippet(instance, {
          check: "folderstack_fullscreen",
          component: "FolderStack",
          properties: ["width", "height"],
          requirement: "exists",
        }),
      ),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "FolderStack 已显式撑满全屏。"),
    instances.map((instance) => ({ file: instance.filePath, line: instance.line })),
  );
}

function checkFolderStackUpperItemIds(
  rule: RegisteredRule,
  scanIndex: ArkuiStaticScanIndex,
): EvaluatedRule {
  const instances = scanIndex.componentInstances.filter(
    (instance) => instance.component === "FolderStack",
  );
  const withUpperItems = instances
    .map((instance) => ({
      instance,
      upperItems: readStringArrayProperty(instance.argumentText, "upperItems"),
    }))
    .filter((item) => item.upperItems.length > 0);
  if (withUpperItems.length === 0) {
    return instances.length === 0
      ? baseResult(rule, "不涉及", "未发现 FolderStack，规则不涉及。")
      : baseResult(rule, "不涉及", "FolderStack 未配置 upperItems，规则不涉及。");
  }
  const failed = withUpperItems.filter(({ instance, upperItems }) => {
    const idsInFile = new Set(
      scanIndex.componentInstances
        .filter((item) => item.filePath === instance.filePath)
        .flatMap((item) => item.properties.filter((property) => property.name === "id"))
        .flatMap((property) => readStringLiterals(property.argumentText)),
    );
    return upperItems.some((id) => !idsInFile.has(id));
  });
  if (failed.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "FolderStack upperItems 存在未匹配的子组件 id。"),
      failed.map(({ instance }) => ({ file: instance.filePath, line: instance.line })),
      failed.map(({ upperItems }) => `upperItems=${upperItems.join(",")}`),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "FolderStack upperItems 均有匹配子组件 id。"),
    withUpperItems.map(({ instance }) => ({ file: instance.filePath, line: instance.line })),
  );
}

function checkCustomHoverFoldAndLandscape(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const files = getEtsFiles(evidence);
  const hoverFiles = getCustomHoverFiles(files);
  if (hoverFiles.length === 0) {
    return baseResult(rule, "不涉及", "未发现自定义悬停态 foldStatusChange，规则不涉及。");
  }
  const badFiles = hoverFiles.filter(
    (file) =>
      (/\bfoldStatusChange\b|\bFOLD_STATUS_HALF_FOLDED\b/.test(file.content) &&
        !/\bFOLD_STATUS_HALF_FOLDED\b/.test(file.content)) ||
      (/\bfoldStatusChange\b|\bFOLD_STATUS_HALF_FOLDED\b/.test(file.content) &&
        !/\b(?:LANDSCAPE|LANDSCAPE_INVERTED|orientation)\b/.test(file.content)),
  );
  if (badFiles.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "自定义悬停态未同时判断半折叠状态和横屏方向。"),
      badFiles.map((file) => ({
        file: file.relativePath,
        line: lineOfPattern(file.content, "foldStatus"),
      })),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "自定义悬停态同时判断半折叠状态和横屏方向。"),
    hoverFiles.map((file) => ({
      file: file.relativePath,
      line: lineOfPattern(file.content, "foldStatus"),
    })),
  );
}

function checkCustomHoverCreaseRegionApi(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const files = getEtsFiles(evidence);
  const hoverFiles = getCustomHoverFiles(files);
  if (hoverFiles.length === 0) {
    return baseResult(rule, "不涉及", "未发现自定义悬停态，规则不涉及。");
  }
  const failed = hoverFiles.filter(
    (file) =>
      !/getCurrentFoldCreaseRegion\s*\(/.test(file.content) || !/\bpx2vp\s*\(/.test(file.content),
  );
  if (failed.length > 0) {
    return withMatches(
      baseResult(
        rule,
        "不满足",
        "自定义悬停态未通过 getCurrentFoldCreaseRegion 和 px2vp 获取折痕区域。",
      ),
      failed.map((file) => ({
        file: file.relativePath,
        line: lineOfPattern(file.content, "foldStatus"),
      })),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "自定义悬停态使用 getCurrentFoldCreaseRegion 和 px2vp 处理折痕区域。"),
    hoverFiles.map((file) => ({
      file: file.relativePath,
      line: lineOfPattern(file.content, "getCurrentFoldCreaseRegion"),
    })),
  );
}

function checkCustomHoverFoldListenerCleanup(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const files = getEtsFiles(evidence);
  const listenerFiles = getCustomHoverFiles(files).filter((file) =>
    /display\.on\s*\(\s*['"]foldStatusChange['"]/.test(file.content),
  );
  if (listenerFiles.length === 0) {
    return baseResult(rule, "不涉及", "未发现自定义悬停态 foldStatusChange 监听注册，规则不涉及。");
  }
  const failed = listenerFiles.filter(
    (file) =>
      !/aboutToDisappear\s*\([^)]*\)\s*(?::\s*[A-Za-z_][A-Za-z0-9_<>,\s.[\]]*)?\s*\{[\s\S]{0,500}display\.off\s*\(\s*['"]foldStatusChange['"]/.test(
        file.content,
      ),
  );
  if (failed.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "foldStatusChange 监听未在 aboutToDisappear 中取消。"),
      failed.map((file) => ({
        file: file.relativePath,
        line: lineOfPattern(file.content, "foldStatusChange"),
      })),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "foldStatusChange 监听在 aboutToDisappear 中取消。"),
    listenerFiles.map((file) => ({
      file: file.relativePath,
      line: lineOfPattern(file.content, "foldStatusChange"),
    })),
  );
}

function checkWebContainerSize(
  rule: RegisteredRule,
  scanIndex: ArkuiStaticScanIndex,
): EvaluatedRule {
  const instances = scanIndex.componentInstances.filter((instance) => instance.component === "Web");
  if (instances.length === 0) {
    return baseResult(rule, "不涉及", "未发现 Web 组件，规则不涉及。");
  }
  const failed = instances.filter((instance) => {
    const width = readPropertyValue(instance, "width");
    const height = readPropertyValue(instance, "height");
    return [width, height].some(
      (value) => value && !isResponsiveValue(value.valueText) && isFixedSize(value.valueText),
    );
  });
  if (failed.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "Web 组件容器存在固定宽高。"),
      failed.map((instance) => ({ file: instance.filePath, line: instance.line })),
      failed.map((instance) =>
        buildInstanceSnippet(instance, {
          check: "web_container_size_by_breakpoint",
          component: "Web",
          properties: ["width", "height"],
          requirement: "breakpoint_aware",
        }),
      ),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "Web 组件容器尺寸未发现固定宽高反模式。"),
    instances.map((instance) => ({ file: instance.filePath, line: instance.line })),
  );
}

function checkWebBreakpointSyncSource(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
  scanIndex: ArkuiStaticScanIndex,
): EvaluatedRule {
  const webInstances = scanIndex.componentInstances.filter(
    (instance) => instance.component === "Web",
  );
  if (webInstances.length === 0) {
    return baseResult(rule, "不涉及", "未发现 Web 组件，规则不涉及。");
  }
  const files = getEtsFiles(evidence);
  const badMatches = findPatternMatches(
    files,
    /\b(?:foldStatusChange|orientation)\b[\s\S]{0,240}\b(?:runJavaScript|javaScriptProxy|breakpoint)\b/g,
  );
  if (badMatches.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "Web 断点同步由 foldStatusChange 或方向 API 驱动。"),
      badMatches,
      snippetsOf(badMatches),
    );
  }
  const goodMatches = findPatternMatches(
    files,
    /\b(?:windowSizeChange|mediaquery\.matchMediaSync)[\s\S]{0,400}\b(?:runJavaScript|javaScriptProxy)\b|\b(?:runJavaScript|javaScriptProxy)[\s\S]{0,400}\b(?:currentBreakpoint|breakpoint|WidthBreakpoint)\b/g,
  );
  if (goodMatches.length === 0) {
    return withMatches(
      baseResult(rule, "不满足", "Web 组件未发现 Native 断点同步逻辑。"),
      webInstances.map((instance) => ({ file: instance.filePath, line: instance.line })),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "Web 组件存在基于标准断点来源的同步逻辑。"),
    goodMatches.slice(0, 10),
  );
}

function checkWebMediaQueryBreakpoints(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const webFiles = getWebResourceFiles(evidence);
  const mediaMatches = findPatternMatches(webFiles, /@media[^{]+(?:min|max)-width\s*:\s*(\d+)px/g);
  if (mediaMatches.length === 0) {
    return baseResult(rule, "不涉及", "未发现 Web 侧 width 媒体查询，规则不涉及。");
  }
  const failed = mediaMatches.filter((match) => {
    const width = /(\d+)px/.exec(match.snippet ?? "")?.[1];
    return width ? !["320", "600", "840", "1440"].includes(width) : false;
  });
  if (failed.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "Web 侧媒体查询断点与系统断点不一致。"),
      failed,
      snippetsOf(failed),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "Web 侧媒体查询断点使用系统推荐值。"),
    mediaMatches.slice(0, 10),
  );
}

function checkWebVerticalBreakpoint(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const webFiles = getWebResourceFiles(evidence);
  const mediaMatches = findPatternMatches(
    webFiles,
    /@media[^{]+(?:orientation|height\s*\/\s*width|min-height|max-height)/g,
  );
  if (mediaMatches.length === 0) {
    const aspectMatches = findPatternMatches(webFiles, /@media[^{]+aspect-ratio/g);
    return aspectMatches.length === 0
      ? baseResult(rule, "不涉及", "未发现 Web 侧纵向断点媒体查询，规则不涉及。")
      : withMatches(
          baseResult(rule, "满足", "Web 侧纵向断点使用 aspect-ratio。"),
          aspectMatches.slice(0, 10),
        );
  }
  return withMatches(
    baseResult(rule, "不满足", "Web 侧纵向断点使用 orientation 或高宽相关条件。"),
    mediaMatches,
    snippetsOf(mediaMatches),
  );
}

function checkDynamicConstraintSize(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
  scanIndex: ArkuiStaticScanIndex,
): EvaluatedRule {
  const matches = findPatternMatches(
    getEtsFiles(evidence),
    /\.constraintSize\s*\(\s*\{[\s\S]{0,300}\b(?:width|maxWidth)\s*:[\s\S]{0,240}\b(?:breakpoint|currentBreakpoint|WidthBreakpoint|sm|md|lg|xl|\?)/gi,
  );
  if (matches.length === 0) {
    return baseResult(
      rule,
      "不涉及",
      "未发现按断点动态设置 width/maxWidth 的 constraintSize，规则不涉及。",
    );
  }
  const hasGridSystem = scanIndex.componentInstances.some(
    (instance) => instance.component === "GridRow" || instance.component === "GridCol",
  );
  if (hasGridSystem) {
    return withMatches(
      baseResult(
        rule,
        "满足",
        "发现动态 constraintSize，同时工程存在 GridRow/GridCol 栅格布局证据，未判定为替代栅格的居中反模式。",
      ),
      matches,
      snippetsOf(matches),
    );
  }
  return withMatches(
    baseResult(rule, "不满足", "发现使用动态 constraintSize 实现大屏居中宽度限制。"),
    matches,
    snippetsOf(matches),
  );
}

function checkAspectRatioByBreakpoint(
  rule: RegisteredRule,
  scanIndex: ArkuiStaticScanIndex,
): EvaluatedRule {
  const instances = scanIndex.componentInstances.filter((instance) =>
    Boolean(readPropertyValue(instance, "aspectRatio")),
  );
  if (instances.length === 0) {
    return baseResult(rule, "不涉及", "未发现 aspectRatio 配置，规则不涉及。");
  }
  const failed = instances.filter((instance) => {
    const value = readPropertyValue(instance, "aspectRatio");
    return value ? !isResponsiveValue(value.valueText) : false;
  });
  if (failed.length > 0) {
    return withMatches(
      baseResult(rule, "不满足", "aspectRatio 未按断点动态设置。"),
      failed.map((instance) => ({
        file: instance.filePath,
        line: readPropertyValue(instance, "aspectRatio")?.line ?? instance.line,
      })),
      failed.map(
        (instance) => `aspectRatio=${readPropertyValue(instance, "aspectRatio")?.valueText ?? ""}`,
      ),
    );
  }
  return withMatches(
    baseResult(rule, "满足", "aspectRatio 均按断点动态设置。"),
    instances.map((instance) => ({
      file: instance.filePath,
      line: readPropertyValue(instance, "aspectRatio")?.line ?? instance.line,
    })),
  );
}

function getScanIndex(evidence: CollectedEvidence): ArkuiStaticScanIndex {
  const cached = scanIndexCache.get(evidence);
  if (cached) {
    return cached;
  }
  const index =
    evidence.arkFacts && evidence.arkFacts.components.length > 0
      ? buildArkuiStaticScanIndexFromArkFacts(evidence.arkFacts)
      : buildArkuiStaticScanIndex(getAllFiles(evidence));
  scanIndexCache.set(evidence, index);
  return index;
}

function getPatchScopedComponentInstances(
  evidence: CollectedEvidence,
  scanIndex: ArkuiStaticScanIndex,
): ArkuiComponentInstance[] {
  return scanIndex.componentInstances.filter((instance) => isPatchScopedInstance(evidence, instance));
}

function isPatchScopedInstance(
  evidence: CollectedEvidence,
  instance: ArkuiComponentInstance,
): boolean {
  return getPatchScopedFileSet(evidence).has(instance.filePath);
}

function getPatchScopedFileSet(evidence: CollectedEvidence): Set<string> {
  const cached = patchScopedFileSetCache.get(evidence);
  if (cached) {
    return cached;
  }
  const fileSet = new Set(evidence.workspaceFiles.map((file) => file.relativePath));
  patchScopedFileSetCache.set(evidence, fileSet);
  return fileSet;
}

function isInstanceSatisfied(
  instance: ArkuiComponentInstance,
  spec: ArkuiRuleSpec,
  scanIndex: ArkuiStaticScanIndex,
): boolean {
  if (spec.properties.length === 0) {
    return true;
  }

  const values = spec.properties.map((property) => readPropertyValue(instance, property));
  if (spec.requirement === "exists") {
    return spec.allPropertiesRequired === true ? values.every(Boolean) : values.some(Boolean);
  }
  if (
    spec.requirement === "breakpoint_aware" &&
    spec.check === "gridcol_span_by_breakpoint" &&
    hasResponsiveGridRowAncestor(scanIndex, instance)
  ) {
    return true;
  }
  if (spec.check === "swiper_indicator_by_display_count") {
    return values.some(
      (value) =>
        value &&
        (isFalseExpression(value.valueText) ||
          value.usesBreakpoint ||
          isResponsiveExpression(value.valueText)),
    );
  }
  if (spec.check === "swiper_margins_for_multi_display") {
    return values.some(Boolean);
  }
  if (spec.check === "waterflow_sliding_window_mode") {
    const columnsTemplate = readPropertyValue(instance, "columnsTemplate")?.valueText ?? "";
    if (!isClearlyDynamicColumnsTemplate(columnsTemplate, scanIndex)) {
      return true;
    }
  }
  if (spec.allPropertiesRequired === true && values.some((value) => !value)) {
    return false;
  }
  const presentValues = values.filter((value): value is PropertyValue => Boolean(value));
  if (presentValues.length === 0) {
    return false;
  }

  if (spec.requirement === "breakpoint_aware") {
    if (
      spec.check === "list_space_by_breakpoint" &&
      isSmOnlyListWithAlternateGrid(instance, scanIndex)
    ) {
      return true;
    }
    if (spec.check === "sidebar_show_by_breakpoint") {
      return presentValues.every((value) =>
        isClearlyVaryingBreakpointBoolean(value.valueText, scanIndex),
      );
    }
    return presentValues.every(
      (value) =>
        value.usesBreakpoint ||
        isResponsiveExpression(value.valueText) ||
        hasBreakpointMap(value.valueText),
    );
  }
  if (spec.requirement === "non_decreasing") {
    return presentValues.every((value) =>
      isNonDecreasingBreakpointMap(resolveConstants(value.valueText, scanIndex), scanIndex),
    );
  }
  if (spec.requirement === "contains") {
    return presentValues.some((value) =>
      spec.expectedText ? value.valueText.includes(spec.expectedText) : true,
    );
  }
  if (spec.requirement === "contains_all") {
    return presentValues.some((value) =>
      (spec.expectedTexts ?? []).every((text) =>
        resolveConstants(value.valueText, scanIndex).includes(text),
      ),
    );
  }
  return false;
}

function shouldDeferInstanceToAgent(
  instance: ArkuiComponentInstance,
  spec: ArkuiRuleSpec,
  scanIndex: ArkuiStaticScanIndex,
): boolean {
  if (
    spec.requirement === "breakpoint_aware" &&
    spec.check === "gridcol_span_by_breakpoint" &&
    hasOpaqueGridRowAncestor(scanIndex, instance)
  ) {
    return true;
  }
  if (!["breakpoint_aware", "non_decreasing", "contains_all"].includes(spec.requirement)) {
    if (
      spec.check === "waterflow_sliding_window_mode" &&
      isOpaqueResponsiveExpression(readPropertyValue(instance, "columnsTemplate")?.valueText ?? "", scanIndex)
    ) {
      return true;
    }
    return false;
  }
  if (spec.check === "list_space_by_breakpoint" && instance.breakpointContext) {
    return true;
  }
  if (spec.check === "gridrow_columns_non_decreasing" && instance.breakpointContext) {
    return true;
  }
  if (spec.check === "sidebar_show_by_breakpoint") {
    return spec.properties
      .map((property) => readPropertyValue(instance, property))
      .filter((value): value is PropertyValue => Boolean(value))
      .some((value) => !isClearlyVaryingBreakpointBoolean(value.valueText, scanIndex));
  }
  if (
    spec.check === "swiper_margins_for_multi_display" &&
    isTrueExpression(readPropertyValue(instance, "disableSwipe")?.valueText ?? "")
  ) {
    return true;
  }
  return spec.properties
    .map((property) => readPropertyValue(instance, property))
    .filter((value): value is PropertyValue => Boolean(value))
    .some((value) => isOpaqueResponsiveExpression(value.valueText, scanIndex));
}

function hasOpaqueGridRowAncestor(
  scanIndex: ArkuiStaticScanIndex,
  target: ArkuiComponentInstance,
): boolean {
  return scanIndex.componentInstances
    .filter(
      (instance) =>
        instance.filePath === target.filePath &&
        instance.component === "GridRow" &&
        instance.startIndex < target.startIndex &&
        instance.endIndex > target.endIndex,
    )
    .some((instance) => {
      const columns = readPropertyValue(instance, "columns")?.valueText;
      return columns ? isOpaqueResponsiveExpression(columns, scanIndex) : false;
    });
}

function isOpaqueResponsiveExpression(
  valueText: string,
  scanIndex?: ArkuiStaticScanIndex,
): boolean {
  const resolved = resolveConstants(valueText, scanIndex).trim();
  if (/^__arkAnalyzerOpaque\([^)]+\)$/.test(resolved)) {
    return true;
  }
  if (!resolved || /^\s*(?:true|false|[0-9]+(?:\.[0-9]+)?|'[^']*'|"[^"]*")\s*$/.test(resolved)) {
    return false;
  }
  if (hasTernaryExpression(resolved)) {
    return true;
  }
  if (hasBreakpointMap(resolved) || readBreakpointHelperNumbers(resolved, scanIndex).length >= 2) {
    return false;
  }
  if (/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.getValue\s*\(/.test(resolved)) {
    return true;
  }
  if (/\b(?:currentBreakpoint|breakpoint|Breakpoint|BREAKPOINT_|sm|md|lg|xl)\b/.test(resolved)) {
    return false;
  }
  return (
    /\b(?:isLargeScreen|isMediumScreen|isSmallScreen|isWideScreen|wideScreen|columnsCount|columnCount)\b/i.test(
      resolved,
    ) ||
    /\b(?:ResourceUtil|[A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*\s*\(/.test(resolved) ||
    /\bthis\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/.test(resolved) ||
    /^\s*this\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*$/.test(resolved) &&
      /(?:displayCount|columns|columnCount|template|lanes|span|width|height)/i.test(resolved)
  );
}

function isInstanceApplicable(
  instance: ArkuiComponentInstance,
  spec: ArkuiRuleSpec,
  scanIndex: ArkuiStaticScanIndex,
): boolean {
  if (isTabsPageNavigationCheck(spec.check)) {
    return isPageLevelTabs(instance, spec, scanIndex);
  }
  if (spec.check === "swiper_indicator_by_display_count") {
    const displayCount = readPropertyValue(instance, "displayCount");
    return Boolean(displayCount && !isFixedDisplayCount(displayCount.valueText, 1));
  }
  if (spec.check === "swiper_margins_for_multi_display") {
    const displayCount = readPropertyValue(instance, "displayCount");
    return Boolean(displayCount && !isFixedDisplayCount(displayCount.valueText, 1));
  }
  if (spec.check === "list_divider_by_lanes") {
    return Boolean(readPropertyValue(instance, "lanes") && readPropertyValue(instance, "divider"));
  }
  if (spec.check === "list_space_by_breakpoint") {
    if (!readPropertyValue(instance, "space")) {
      return false;
    }
    if (instance.breakpointContext) {
      return true;
    }
    const lanes = readPropertyValue(instance, "lanes")?.valueText;
    if (!lanes) {
      return false;
    }
    return hasResponsiveLayoutEvidence(lanes, scanIndex);
  }
  if (spec.check === "gridrow_gutter_required") {
    return hasMultipleGridColChildren(instance, scanIndex);
  }
  if (spec.check === "waterflow_sliding_window_mode") {
    const columnsTemplate = readPropertyValue(instance, "columnsTemplate")?.valueText;
    return Boolean(
      columnsTemplate &&
        (isClearlyDynamicColumnsTemplate(columnsTemplate, scanIndex) ||
          isOpaqueResponsiveExpression(columnsTemplate, scanIndex)),
    );
  }
  if (spec.properties.length === 0) {
    return true;
  }
  if (spec.ignoreMissingProperties !== true) {
    return true;
  }
  return spec.properties.some((property) => Boolean(readPropertyValue(instance, property)));
}

function readPropertyValue(
  instance: ArkuiComponentInstance,
  propertyName: string,
): PropertyValue | undefined {
  const chainedProperty = instance.properties.find((property) => property.name === propertyName);
  if (chainedProperty) {
    return {
      name: propertyName,
      valueText: chainedProperty.argumentText,
      line: chainedProperty.line,
      usesBreakpoint: chainedProperty.usesBreakpoint,
    };
  }

  const constructorValue = readObjectProperty(instance.argumentText, propertyName);
  if (!constructorValue && instance.component === "SideBarContainer" && propertyName === "type") {
    const argumentText = instance.argumentText.trim();
    if (argumentText && !argumentText.startsWith("{")) {
      return {
        name: propertyName,
        valueText: argumentText,
        line: instance.line,
        usesBreakpoint: hasBreakpointExpression(argumentText),
      };
    }
  }
  if (!constructorValue) {
    return undefined;
  }
  return {
    name: propertyName,
    valueText: constructorValue,
    line: instance.line,
    usesBreakpoint: hasBreakpointExpression(constructorValue),
  };
}

function readObjectProperty(argumentText: string, propertyName: string): string | undefined {
  const propertyStart = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:`).exec(argumentText);
  if (!propertyStart?.[0] || propertyStart.index === undefined) {
    return undefined;
  }
  let cursor = propertyStart.index + propertyStart[0].length;
  while (/\s/.test(argumentText[cursor] ?? "")) {
    cursor += 1;
  }

  const end = findObjectPropertyValueEnd(argumentText, cursor);
  return argumentText.slice(cursor, end).trim();
}

function findObjectPropertyValueEnd(content: string, startIndex: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let mode: "code" | "single" | "double" | "template" = "code";

  for (let index = startIndex; index < content.length; index += 1) {
    const current = content[index] ?? "";
    const next = content[index + 1] ?? "";

    if (mode !== "code") {
      const quote = mode === "single" ? "'" : mode === "double" ? '"' : "`";
      if (current === "\\" && next) {
        index += 1;
        continue;
      }
      if (current === quote) {
        mode = "code";
      }
      continue;
    }

    if (current === "'") {
      mode = "single";
      continue;
    }
    if (current === '"') {
      mode = "double";
      continue;
    }
    if (current === "`") {
      mode = "template";
      continue;
    }
    if (current === "(") {
      parenDepth += 1;
      continue;
    }
    if (current === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (current === "[") {
      bracketDepth += 1;
      continue;
    }
    if (current === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (current === "{") {
      braceDepth += 1;
      continue;
    }
    if (current === "}") {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return index;
      }
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (current === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return index;
    }
  }
  return content.length;
}

function hasBreakpointMap(valueText: string): boolean {
  return (
    ["sm", "md", "lg", "xl"].filter((name) => new RegExp(`\\b${name}\\s*:`).test(valueText))
      .length >= 2
  );
}

function isClearlyVaryingBreakpointBoolean(
  valueText: string,
  scanIndex: ArkuiStaticScanIndex,
): boolean {
  const resolved = resolveConstants(valueText, scanIndex);
  const mapValues = ["sm", "md", "lg", "xl"].flatMap((name) => {
    const match = new RegExp(`\\b${name}\\s*:\\s*(true|false)\\b`).exec(resolved);
    return match?.[1] ? [match[1]] : [];
  });
  if (mapValues.length >= 2) {
    return new Set(mapValues).size >= 2;
  }

  const helperMatch = /\bnew\s+[A-Za-z_$][\w$]*\s*\(([\s\S]*?)\)\s*\.getValue\s*\(/.exec(
    resolved,
  );
  if (!helperMatch?.[1]) {
    return false;
  }
  const helperValues = splitTopLevelArguments(helperMatch[1])
    .map((part) => resolveConstants(part.trim(), scanIndex))
    .filter((part) => /^(?:true|false)$/.test(part));
  return helperValues.length >= 2 && new Set(helperValues).size >= 2;
}

function hasBreakpointExpression(valueText: string): boolean {
  return isResponsiveExpression(valueText);
}

function isResponsiveExpression(valueText: string): boolean {
  return (
    hasBreakpointMap(valueText) ||
    /\b(?:sm|md|lg|xl)\b/.test(valueText) ||
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.BREAKPOINT_(?:SM|MD|LG|XL)\b/.test(
      valueText,
    ) ||
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.getValue\s*\(/.test(valueText) ||
    /\bnew\s+[A-Za-z_$][\w$]*\s*\([^)]*,[^)]*,[^)]*\)\s*\.getValue\s*\(/.test(valueText) ||
    /\b(?:isWideScreen|wideScreen|columnsCount|columnCount)\b/i.test(valueText)
  );
}

function isNonDecreasingBreakpointMap(
  valueText: string,
  scanIndex?: ArkuiStaticScanIndex,
): boolean {
  if (/^\s*[0-9]+(?:\.[0-9]+)?\s*$/.test(valueText)) {
    return true;
  }
  const helperValues = readBreakpointHelperNumbers(valueText, scanIndex);
  if (helperValues.length >= 2) {
    return helperValues.every((value, index) => index === 0 || value >= (helperValues[index - 1] ?? value));
  }
  const values = ["sm", "md", "lg", "xl"].flatMap((name) => {
    const match = new RegExp(`\\b${name}\\s*:\\s*([0-9]+)`).exec(valueText);
    return match?.[1] ? [Number(match[1])] : [];
  });
  if (values.length < 2) {
    return isResponsiveExpression(valueText) || isStableColumnsTemplate(valueText);
  }
  return values.every((value, index) => index === 0 || value >= (values[index - 1] ?? value));
}

function readBreakpointHelperNumbers(valueText: string, scanIndex?: ArkuiStaticScanIndex): number[] {
  const match = /\bnew\s+[A-Za-z_$][\w$]*\s*\(([\s\S]*?)\)\s*\.getValue\s*\(/.exec(valueText);
  if (!match?.[1]) {
    return [];
  }
  return splitTopLevelArguments(match[1])
    .map((part) => resolveConstants(part.trim(), scanIndex))
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value));
}

function splitTopLevelArguments(content: string): string[] {
  const values: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let mode: "code" | "single" | "double" | "template" = "code";

  for (let index = 0; index < content.length; index += 1) {
    const current = content[index] ?? "";
    const next = content[index + 1] ?? "";
    if (mode !== "code") {
      const quote = mode === "single" ? "'" : mode === "double" ? '"' : "`";
      if (current === "\\" && next) {
        index += 1;
        continue;
      }
      if (current === quote) {
        mode = "code";
      }
      continue;
    }
    if (current === "'") {
      mode = "single";
      continue;
    }
    if (current === '"') {
      mode = "double";
      continue;
    }
    if (current === "`") {
      mode = "template";
      continue;
    }
    if (current === "(") {
      parenDepth += 1;
      continue;
    }
    if (current === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (current === "[") {
      bracketDepth += 1;
      continue;
    }
    if (current === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (current === "{") {
      braceDepth += 1;
      continue;
    }
    if (current === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (current === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      values.push(content.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(content.slice(start).trim());
  return values.filter(Boolean);
}

function isStableColumnsTemplate(valueText: string): boolean {
  if (/\btemplate/i.test(valueText)) {
    return true;
  }
  const templateCounts = [...valueText.matchAll(/['"]([^'"]*fr[^'"]*)['"]/g)]
    .map((match) => match[1] ?? "")
    .map((template) => template.trim().split(/\s+/).filter(Boolean).length)
    .filter((count) => count > 0);
  if (templateCounts.length === 0) {
    return false;
  }
  if (templateCounts.length === 1) {
    return true;
  }
  return hasBreakpointExpression(valueText);
}

function hasResponsiveGridRowAncestor(
  scanIndex: ArkuiStaticScanIndex,
  target: ArkuiComponentInstance,
): boolean {
  return scanIndex.componentInstances
    .filter(
      (instance) =>
        instance.filePath === target.filePath &&
        instance.component === "GridRow" &&
        instance.startIndex < target.startIndex &&
        instance.endIndex > target.endIndex,
    )
    .some((instance) => {
      const columns = resolveConstants(
        readPropertyValue(instance, "columns")?.valueText ?? "",
        scanIndex,
      );
      return columns
        ? isNonDecreasingBreakpointMap(columns) ||
            hasBreakpointExpression(columns) ||
            hasBreakpointMap(columns)
        : false;
    });
}

function isSmOnlyListWithAlternateGrid(
  instance: ArkuiComponentInstance,
  scanIndex: ArkuiStaticScanIndex,
): boolean {
  const condition = instance.breakpointCondition ?? "";
  const isSmBranch =
    /\b(?:curBp|currentBreakpoint|breakpoint)\b[^;\n{}]*(?<!!)={2,3}\s*['"]sm['"]|['"]sm['"]\s*(?<!!)={2,3}\s*\b(?:curBp|currentBreakpoint|breakpoint)\b/i.test(
      condition,
    );
  if (!isSmBranch) {
    return false;
  }
  return scanIndex.componentInstances.some(
    (item) =>
      item.filePath === instance.filePath &&
      item.component === "GridRow" &&
      item.startIndex > instance.endIndex,
  );
}

function hasResponsiveLayoutEvidence(valueText: string, scanIndex: ArkuiStaticScanIndex): boolean {
  const resolved = resolveConstants(valueText, scanIndex);
  return (
    hasBreakpointMap(resolved) ||
    readBreakpointHelperNumbers(resolved, scanIndex).length >= 2 ||
    isResponsiveExpression(resolved) ||
    isOpaqueResponsiveExpression(resolved, scanIndex)
  );
}

function hasMultipleGridColChildren(
  instance: ArkuiComponentInstance,
  scanIndex: ArkuiStaticScanIndex,
): boolean {
  const children = scanIndex.componentInstances.filter(
    (item) =>
      item.filePath === instance.filePath &&
      item.component === "GridCol" &&
      item.startIndex > instance.startIndex &&
      item.endIndex < instance.endIndex,
  );
  return children.length >= 2;
}

function isClearlyDynamicColumnsTemplate(
  valueText: string,
  scanIndex: ArkuiStaticScanIndex,
): boolean {
  const resolved = resolveConstants(valueText, scanIndex);
  if (hasTernaryExpression(resolved)) {
    return false;
  }
  if (hasBreakpointMap(resolved) || readBreakpointHelperNumbers(resolved, scanIndex).length >= 2) {
    return true;
  }
  const templates = [...resolved.matchAll(/['"]([^'"]*fr[^'"]*)['"]/g)].map(
    (match) => match[1] ?? "",
  );
  return new Set(templates).size >= 2 && isResponsiveExpression(resolved);
}

function isTabsPageNavigationCheck(check: string): boolean {
  return [
    "tabs_vertical_by_breakpoint",
    "tabs_bar_position_by_breakpoint",
    "tabs_bar_size_by_breakpoint",
  ].includes(check);
}

function isPageLevelTabs(
  instance: ArkuiComponentInstance,
  spec: ArkuiRuleSpec,
  scanIndex: ArkuiStaticScanIndex,
): boolean {
  if (spec.properties.some((property) => isResponsiveExpression(readPropertyValue(instance, property)?.valueText ?? ""))) {
    return true;
  }
  const descendants = scanIndex.componentInstances.filter(
    (item) =>
      item.filePath === instance.filePath &&
      item.startIndex > instance.startIndex &&
      item.endIndex < instance.endIndex,
  );
  const tabContentCount = descendants.filter((item) => item.component === "TabContent").length;
  if (tabContentCount < 2) {
    return false;
  }
  const descendantComponents = new Set(descendants.map((item) => item.component));
  if (
    (descendantComponents.has("List") || descendantComponents.has("ListItem")) &&
    !descendantComponents.has("NavDestination") &&
    !descendantComponents.has("Navigation")
  ) {
    return false;
  }
  return descendants.some((item) =>
    /(?:NavDestination|Navigation|Page|Content|Root|Entry)/.test(item.component),
  );
}

function isFixedDisplayCount(valueText: string, expected: number): boolean {
  return Number(resolveConstants(valueText).trim()) === expected;
}

function isFalseExpression(valueText: string): boolean {
  return /^\s*false\s*$/.test(valueText);
}

function isTrueExpression(valueText: string): boolean {
  return /^\s*true\s*$/.test(valueText);
}

function hasTernaryExpression(valueText: string): boolean {
  return valueText.includes("?") && valueText.includes(":");
}

function getCustomHoverFiles(files: ScanFile[]): ScanFile[] {
  return files.filter((file) => {
    const content = file.content;
    if (/\b(?:FolderStack|FoldSplitContainer|upperItems|getCurrentFoldCreaseRegion)\b/.test(content)) {
      return true;
    }
    if (
      /\bFOLD_STATUS_HALF_FOLDED\b/.test(content) &&
      /\b(?:LANDSCAPE|LANDSCAPE_INVERTED|orientation)\b/.test(content)
    ) {
      return true;
    }
    if (
      /\bfoldStatusChange\b/.test(content) &&
      /\bFOLD_STATUS_HALF_FOLDED\b/.test(content) &&
      /\b(?:height|width|position|visibility|translate|top|bottom|upper|lower)\b[\s\S]{0,240}\b(?:foldStatus|FOLD_STATUS_HALF_FOLDED)\b|\b(?:foldStatus|FOLD_STATUS_HALF_FOLDED)\b[\s\S]{0,240}\b(?:height|width|position|visibility|translate|top|bottom|upper|lower)\b/.test(
        content,
      )
    ) {
      return true;
    }
    return false;
  });
}

function resolveConstants(valueText: string, scanIndex?: ArkuiStaticScanIndex): string {
  return valueText
    .replace(
      /\b[A-Z][A-Za-z0-9_]*\.([A-Z][A-Z0-9_]*)\[(\d+)\]/g,
      (_match, name: string, indexText: string) => {
        const values = readNumericArray(scanIndex?.constants[name] ?? "");
        const value = values[Number(indexText)];
        return value === undefined ? _match : String(value);
      },
    )
    .replace(/\b[A-Z][A-Za-z0-9_]*\.([A-Z][A-Z0-9_]*)\b/g, (_match, name: string) => {
      const value = scanIndex?.constants[name];
      return value ?? _match;
    })
    .replace(/\b([A-Z][A-Z0-9_]*)\[(\d+)\]/g, (_match, name: string, indexText: string) => {
      const values = readNumericArray(scanIndex?.constants[name] ?? "");
      const value = values[Number(indexText)];
      return value === undefined ? _match : String(value);
    })
    .replace(/\b([A-Z][A-Z0-9_]*)\b/g, (_match, name: string) => {
      const value = scanIndex?.constants[name];
      return value ?? _match;
    });
}

function readNumericArray(valueText: string): number[] {
  const match = /^\s*\[([^\]]*)\]\s*$/.exec(valueText);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

function baseResult(
  rule: RegisteredRule,
  result: EvaluatedRule["result"],
  conclusion: string,
  preliminaryData: Record<string, unknown> = {},
): EvaluatedRule {
  return {
    rule_id: rule.rule_id,
    rule_source: rule.rule_source,
    result,
    conclusion,
    matchedFiles: [],
    preliminaryData,
  };
}

function buildPreliminaryData(
  spec: ArkuiRuleSpec,
  instances: ArkuiComponentInstance[],
): Record<string, unknown> {
  return {
    check: spec.check,
    component: spec.component,
    properties: spec.properties,
    requirement: spec.requirement,
    inspectedComponentCount: instances.length,
    inspectedComponents: instances.map((instance) => ({
      filePath: instance.filePath,
      line: instance.line,
      properties: instance.properties.map((property) => ({
        name: property.name,
        line: property.line,
        usesBreakpoint: property.usesBreakpoint,
      })),
      checkedProperties: spec.properties
        .map((property) => readPropertyValue(instance, property))
        .filter((property): property is PropertyValue => Boolean(property))
        .map((property) => ({
          name: property.name,
          line: property.line,
          valueText: property.valueText,
          usesBreakpoint: property.usesBreakpoint,
        })),
      breakpointContext: instance.breakpointContext,
    })),
  };
}

function writeDebugArtifacts(
  evidence: CollectedEvidence,
  rule: RegisteredRule,
  result: EvaluatedRule,
  scanIndex = getScanIndex(evidence),
): void {
  if (!evidence.caseDir) {
    return;
  }

  const artifactDir = path.join(evidence.caseDir, "intermediate", "arkui-static-scan");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, "arkui-scan-index.json"),
    `${JSON.stringify(scanIndex, null, 2)}\n`,
    "utf-8",
  );

  const traces = ruleTraceCache.get(evidence) ?? [];
  traces.push({
    ruleId: rule.rule_id,
    check: typeof rule.detector.config.check === "string" ? rule.detector.config.check : undefined,
    result: result.result,
    conclusion: result.conclusion,
    matchedFiles: result.matchedFiles,
    matchedLocations: result.matchedLocations ?? [],
    matchedSnippets: result.matchedSnippets ?? [],
    preliminaryData: result.preliminaryData ?? {},
  });
  ruleTraceCache.set(evidence, traces);
  fs.writeFileSync(
    path.join(artifactDir, "arkui-rule-traces.json"),
    `${JSON.stringify({ ruleTraces: traces }, null, 2)}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(artifactDir, "unresolved-expressions.json"),
    `${JSON.stringify({ unresolvedExpressions: collectUnresolvedExpressions(scanIndex) }, null, 2)}\n`,
    "utf-8",
  );
}

function collectUnresolvedExpressions(
  scanIndex: ArkuiStaticScanIndex,
): Array<Record<string, unknown>> {
  return scanIndex.componentInstances.flatMap((instance) =>
    instance.properties
      .filter((property) => property.argumentText.includes("=>"))
      .map((property) => ({
        filePath: instance.filePath,
        line: property.line,
        component: instance.component,
        property: property.name,
        expression: property.argumentText,
        reason: "callback_expression",
      })),
  );
}

function buildInstanceSnippet(instance: ArkuiComponentInstance, spec: ArkuiRuleSpec): string {
  return `${instance.component}(${instance.argumentText}) ${spec.properties
    .map((property) => {
      const value = readPropertyValue(instance, property);
      return `${property}=${value?.valueText ?? "<missing>"}`;
    })
    .join(" ")}`;
}

function buildPropertySnippet(instance: ArkuiComponentInstance, spec: ArkuiRuleSpec): string {
  return spec.properties
    .map((property) => readPropertyValue(instance, property))
    .filter((value): value is PropertyValue => Boolean(value))
    .map((value) => `${value.name}=${value.valueText}`)
    .join("; ");
}

function buildReviewEvidence(
  spec: ArkuiRuleSpec,
  instances: ArkuiComponentInstance[],
): Array<Record<string, unknown>> {
  return instances.map((instance) => ({
    rule_id: spec.check,
    file: instance.filePath,
    line: instance.line,
    subject: instance.component,
    evidence: buildPropertySnippet(instance, spec),
    question: `请结合规则描述和源码上下文复核该 ${instance.component} 是否满足一多适配要求。`,
  }));
}

function buildManualReviewEvidence(
  spec: ArkuiRuleSpec,
  instances: ArkuiComponentInstance[],
  evidence: CollectedEvidence,
): Array<Record<string, unknown>> {
  return instances.map((instance) => ({
    rule_id: spec.check,
    file: instance.filePath,
    line: instance.line,
    subject: instance.component,
    ...(instance.source === "arkFacts"
      ? { structure: buildComponentStructureEvidence(instance) }
      : { source: buildComponentSourceSnippet(instance, evidence) }),
    question: `请结合源码片段中的 ${instance.component} 子组件职责判断该规则是否适用，以及是否满足一多适配要求。`,
  }));
}

function buildComponentStructureEvidence(instance: ArkuiComponentInstance): Record<string, unknown> {
  return {
    componentId: instance.componentId,
    parent: instance.parentComponent,
    children: instance.childComponents ?? [],
    attributes: buildStructureAttributes(instance),
  };
}

function buildStructureAttributes(
  instance: ArkuiComponentInstance,
): Array<{ name: string; valueText: string }> {
  return [
    ...readConstructorStructureAttributes(instance.argumentText),
    ...instance.properties.map((property) => ({
      name: property.name,
      valueText: property.argumentText,
    })),
  ];
}

function readConstructorStructureAttributes(argumentText: string): Array<{ name: string; valueText: string }> {
  const trimmed = argumentText.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed ? [{ name: "constructor", valueText: trimmed }] : [];
  }
  return [...trimmed.matchAll(/\b([A-Za-z_$][\w$]*)\s*:/g)].flatMap((match) => {
    const name = match[1];
    if (!name) {
      return [];
    }
    return [{ name, valueText: readObjectProperty(trimmed, name) ?? "<unknown>" }];
  });
}

function buildManualReviewSnippet(
  instance: ArkuiComponentInstance,
  spec: ArkuiRuleSpec,
  evidence: CollectedEvidence,
): string {
  if (instance.source !== "arkFacts") {
    return buildComponentSourceSnippet(instance, evidence);
  }
  const props = buildStructureAttributes(instance)
    .map((property) => `${property.name}=${property.valueText}`)
    .join("; ");
  return `${instance.component} parent=${instance.parentComponent ?? "<none>"} children=${(instance.childComponents ?? []).join(",") || "<none>"} props=${props || buildPropertySnippet(instance, spec) || "<none>"}`;
}

function buildComponentSourceSnippet(
  instance: ArkuiComponentInstance,
  evidence: CollectedEvidence,
): string {
  const file = getAllFiles(evidence).find((item) => item.relativePath === instance.filePath);
  if (!file) {
    return `${instance.component}(${instance.argumentText})`;
  }
  const lines = file.content.split(/\r?\n/);
  const startLine = Math.max(1, instance.line - 1);
  const endLine = Math.min(lines.length, instance.line + 8);
  return lines.slice(startLine - 1, endLine).join("\n").trim();
}

function describeRequirement(spec: ArkuiRuleSpec): string {
  if (spec.check === "swiper_margins_for_multi_display") {
    return "多元素展示时至少配置 prevMargin 或 nextMargin 一侧边距";
  }
  if (spec.requirement === "breakpoint_aware") {
    return "按断点动态设置";
  }
  if (spec.requirement === "non_decreasing") {
    return "断点数值非递减";
  }
  if (spec.requirement === "exists") {
    return "显式配置";
  }
  if (spec.requirement === "contains_all") {
    return `包含 ${(spec.expectedTexts ?? []).join("/")}`;
  }
  return `包含 ${spec.expectedText ?? "指定值"}`;
}

type ScanFile = { relativePath: string; content: string };
type LocationMatch = { file: string; line: number; snippet?: string };

function getAllFiles(evidence: CollectedEvidence): ScanFile[] {
  return evidence.allWorkspaceFiles ?? evidence.workspaceFiles;
}

function getEtsFiles(evidence: CollectedEvidence): ScanFile[] {
  return getAllFiles(evidence).filter((file) => file.relativePath.endsWith(".ets"));
}

function getWebResourceFiles(evidence: CollectedEvidence): ScanFile[] {
  return getAllFiles(evidence).filter((file) =>
    /\.(?:css|html?|js|ts|ets)$/.test(file.relativePath),
  );
}

function withMatches(
  result: EvaluatedRule,
  matches: LocationMatch[],
  snippets: string[] = matches.flatMap((match) => (match.snippet ? [match.snippet] : [])),
): EvaluatedRule {
  const matchedLocations = matches.map((match) => `${match.file}:${match.line}`);
  return {
    ...result,
    conclusion: appendViolationLocations(result, matchedLocations),
    matchedFiles: unique(matches.map((match) => match.file)),
    matchedLocations,
    matchedSnippets: snippets,
  };
}

function appendViolationLocations(result: EvaluatedRule, locations: string[]): string {
  if (result.result !== "不满足" || locations.length === 0 || /(?:位置|文件)：/.test(result.conclusion)) {
    return result.conclusion;
  }
  return `${result.conclusion} 位置：${unique(locations).join(", ")}`;
}

function findPatternMatches(files: ScanFile[], pattern: RegExp): LocationMatch[] {
  return files.flatMap((file) => {
    const matches: LocationMatch[] = [];
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const regex = new RegExp(pattern.source, flags);
    for (const match of file.content.matchAll(regex)) {
      const index = match.index ?? 0;
      matches.push({
        file: file.relativePath,
        line: lineAtContent(file.content, index),
        snippet: compactSnippet(file.content.slice(index, index + Math.max(match[0].length, 120))),
      });
    }
    return matches;
  });
}

function readStringArrayProperty(content: string, propertyName: string): string[] {
  const match = new RegExp(`["']?${escapeRegExp(propertyName)}["']?\\s*:\\s*\\[([^\\]]*)\\]`).exec(
    content,
  );
  if (!match?.[1]) {
    return [];
  }
  return readStringLiterals(match[1]);
}

function readStringProperty(content: string, propertyName: string): string | undefined {
  const match = new RegExp(`["']?${escapeRegExp(propertyName)}["']?\\s*:\\s*["']([^"']+)["']`).exec(
    content,
  );
  return match?.[1];
}

function isHapModule(moduleJson5Content: string): boolean {
  const type = readStringProperty(moduleJson5Content, "type");
  return type === "entry" || type === "feature";
}

function readStringLiterals(content: string): string[] {
  return [...content.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1] ?? "").filter(Boolean);
}

function lineOfPattern(content: string, pattern: string): number {
  const index = content.indexOf(pattern);
  return lineAtContent(content, index < 0 ? 0 : index);
}

function lineAtContent(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function compactSnippet(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 240);
}

function snippetsOf(matches: LocationMatch[]): string[] {
  return matches.flatMap((match) => (match.snippet ? [match.snippet] : []));
}

function isFullSize(valueText: string | undefined): boolean {
  return Boolean(valueText && /['"]100%['"]|FULL|matchParent/i.test(valueText));
}

function isFixedSize(valueText: string): boolean {
  return /^\s*(?:[0-9]+(?:\.[0-9]+)?|['"][0-9]+(?:\.[0-9]+)?(?:vp|px)?['"])\s*$/.test(valueText);
}

function isResponsiveValue(valueText: string): boolean {
  return (
    hasBreakpointExpression(valueText) ||
    hasBreakpointMap(valueText) ||
    /\?|getValue|currentBreakpoint|WidthBreakpoint/i.test(valueText)
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function findBalancedEnd(
  content: string,
  openIndex: number,
  openToken: string,
  closeToken: string,
): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    if (content[index] === openToken) {
      depth += 1;
    } else if (content[index] === closeToken) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
