export type ArkuiRequirement =
  | "breakpoint_aware"
  | "non_decreasing"
  | "exists"
  | "contains"
  | "contains_all";

export interface ArkuiRuleSpec {
  check: string;
  component: string;
  properties: string[];
  requirement: ArkuiRequirement;
  allPropertiesRequired?: boolean;
  ignoreMissingProperties?: boolean;
  expectedText?: string;
  expectedTexts?: string[];
}

// 组件属性类静态规则规格表：只描述检查目标，不包含具体判定过程。
const ARKUI_RULE_SPECS: ArkuiRuleSpec[] = [
  breakpointAware("tabs_vertical_by_breakpoint", "Tabs", ["vertical"]),
  breakpointAware("tabs_bar_position_by_breakpoint", "Tabs", ["barPosition"]),
  breakpointAware("tabs_bar_size_by_breakpoint", "Tabs", ["barWidth", "barHeight"], true),
  breakpointAware("sidebar_show_by_breakpoint", "SideBarContainer", ["showSideBar"]),
  breakpointAware("sidebar_width_by_breakpoint", "SideBarContainer", ["sideBarWidth"]),
  breakpointAware("sidebar_type_by_breakpoint", "SideBarContainer", ["type"]),
  containsAll(
    "gridrow_breakpoints_standard",
    "GridRow",
    ["breakpoints"],
    ["320vp", "600vp", "840vp", "1440vp"],
    true,
  ),
  nonDecreasing("gridrow_columns_non_decreasing", "GridRow", ["columns"]),
  exists("gridrow_gutter_required", "GridRow", ["gutter"]),
  nonDecreasing("grid_columns_template_non_decreasing", "Grid", ["columnsTemplate"]),
  breakpointAware("gridcol_span_by_breakpoint", "GridCol", ["span"]),
  exists("gridcol_offset_required", "GridCol", ["offset"]),
  nonDecreasing("list_lanes_non_decreasing", "List", ["lanes"]),
  breakpointAware("list_space_by_breakpoint", "List", ["space"]),
  breakpointAware("list_divider_by_lanes", "List", ["divider"], false, true),
  nonDecreasing("waterflow_columns_template_non_decreasing", "WaterFlow", ["columnsTemplate"]),
  contains("waterflow_sliding_window_mode", "WaterFlow", ["layoutMode"], "SLIDING_WINDOW"),
  exists("waterflow_item_constraint_size", "WaterFlow", ["itemConstraintSize"]),
  nonDecreasing("swiper_display_count_non_decreasing", "Swiper", ["displayCount"]),
  breakpointAware("swiper_indicator_by_display_count", "Swiper", ["indicator"], false, true),
  breakpointAware(
    "swiper_margins_for_multi_display",
    "Swiper",
    ["prevMargin", "nextMargin"],
    true,
    true,
  ),
  exists("navigation_nav_bar_width_required", "Navigation", ["navBarWidth"]),
  exists("flex_grow_shrink_required", "Flex", ["flexGrow", "flexShrink"]),
  contains("flex_space_evenly_required", "Flex", ["justifyContent"], "SpaceEvenly"),
  contains("flex_wrap_required", "Flex", ["wrap"], "Wrap"),
  exists("row_column_layout_weight_required", "Row", ["layoutWeight"]),
  exists("column_layout_weight_required", "Column", ["layoutWeight"]),
  exists("row_column_display_priority_required", "Row", ["displayPriority"]),
  exists("column_display_priority_required", "Column", ["displayPriority"]),
  exists("blank_spacing_required", "Blank", []),
  contains("horizontal_scroll_required", "Scroll", ["scrollable"], "Horizontal"),
];

export const ARKUI_RULE_SPEC_BY_CHECK = new Map(ARKUI_RULE_SPECS.map((spec) => [spec.check, spec]));

// 文本/工程级检查不绑定单个组件实例，由 evaluator 内的专用函数处理。
export const TEXT_STATIC_CHECKS = new Set([
  "module_device_types_multi_device",
  "breakpoint_ranges_standard",
  "breakpoint_no_hardcoded_width",
  "breakpoint_source_standard",
  "breakpoint_listener_source_standard",
  "breakpoint_listener_after_load_content",
  "folderstack_fullscreen",
  "folderstack_upper_items_ids",
  "custom_hover_fold_and_landscape",
  "custom_hover_crease_region_api",
  "custom_hover_fold_listener_cleanup",
  "web_container_size_by_breakpoint",
  "web_breakpoint_sync_source",
  "web_media_query_breakpoints_standard",
  "web_vertical_breakpoint_aspect_ratio",
  "gridrow_no_dynamic_constraint_size_centering",
  "aspect_ratio_by_breakpoint",
]);

// 这些规则的适用性依赖布局意图，静态层只提供证据并交给 Agent 复核。
export const MANUAL_APPLICABILITY_CHECKS = new Set([
  "flex_grow_shrink_required",
  "navigation_nav_bar_width_required",
  "gridcol_offset_required",
  "flex_space_evenly_required",
  "flex_wrap_required",
  "row_column_layout_weight_required",
  "column_layout_weight_required",
  "row_column_display_priority_required",
  "column_display_priority_required",
  "horizontal_scroll_required",
  "waterflow_item_constraint_size",
]);

function breakpointAware(
  check: string,
  component: string,
  properties: string[],
  allPropertiesRequired = false,
  ignoreMissingProperties = false,
): ArkuiRuleSpec {
  return {
    check,
    component,
    properties,
    requirement: "breakpoint_aware",
    allPropertiesRequired,
    ignoreMissingProperties,
  };
}

function nonDecreasing(check: string, component: string, properties: string[]): ArkuiRuleSpec {
  return {
    check,
    component,
    properties,
    requirement: "non_decreasing",
    ignoreMissingProperties: true,
  };
}

function exists(check: string, component: string, properties: string[]): ArkuiRuleSpec {
  return { check, component, properties, requirement: "exists" };
}

function contains(
  check: string,
  component: string,
  properties: string[],
  expectedText: string,
): ArkuiRuleSpec {
  return { check, component, properties, requirement: "contains", expectedText };
}

function containsAll(
  check: string,
  component: string,
  properties: string[],
  expectedTexts: string[],
  ignoreMissingProperties = false,
): ArkuiRuleSpec {
  return {
    check,
    component,
    properties,
    requirement: "contains_all",
    expectedTexts,
    ignoreMissingProperties,
  };
}
