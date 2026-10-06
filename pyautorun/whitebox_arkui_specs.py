"""ArkUI component rule targets and applicability classes."""


def _spec(check, component, properties, requirement, **extra):
    return {"check": check, "component": component, "properties": properties,
            "requirement": requirement, **extra}


SPECS = [
    _spec("tabs_vertical_by_breakpoint", "Tabs", ["vertical"], "breakpoint_aware", allPropertiesRequired=False, ignoreMissingProperties=False),
    _spec("tabs_bar_position_by_breakpoint", "Tabs", ["barPosition"], "breakpoint_aware", allPropertiesRequired=False, ignoreMissingProperties=False),
    _spec("tabs_bar_size_by_breakpoint", "Tabs", ["barWidth", "barHeight"], "breakpoint_aware", allPropertiesRequired=True, ignoreMissingProperties=False),
    _spec("sidebar_show_by_breakpoint", "SideBarContainer", ["showSideBar"], "breakpoint_aware", allPropertiesRequired=False, ignoreMissingProperties=False),
    _spec("sidebar_width_by_breakpoint", "SideBarContainer", ["sideBarWidth"], "breakpoint_aware", allPropertiesRequired=False, ignoreMissingProperties=False),
    _spec("sidebar_type_by_breakpoint", "SideBarContainer", ["type"], "breakpoint_aware", allPropertiesRequired=False, ignoreMissingProperties=False),
    _spec("gridrow_breakpoints_standard", "GridRow", ["breakpoints"], "contains_all", expectedTexts=["320vp", "600vp", "840vp", "1440vp"], ignoreMissingProperties=True),
    _spec("gridrow_columns_non_decreasing", "GridRow", ["columns"], "non_decreasing", ignoreMissingProperties=True),
    _spec("gridrow_gutter_required", "GridRow", ["gutter"], "exists"),
    _spec("grid_columns_template_non_decreasing", "Grid", ["columnsTemplate"], "non_decreasing", ignoreMissingProperties=True),
    _spec("gridcol_span_by_breakpoint", "GridCol", ["span"], "breakpoint_aware", allPropertiesRequired=False, ignoreMissingProperties=False),
    _spec("gridcol_offset_required", "GridCol", ["offset"], "exists"),
    _spec("list_lanes_non_decreasing", "List", ["lanes"], "non_decreasing", ignoreMissingProperties=True),
    _spec("list_space_by_breakpoint", "List", ["space"], "breakpoint_aware", allPropertiesRequired=False, ignoreMissingProperties=False),
    _spec("list_divider_by_lanes", "List", ["divider"], "breakpoint_aware", allPropertiesRequired=False, ignoreMissingProperties=True),
    _spec("waterflow_columns_template_non_decreasing", "WaterFlow", ["columnsTemplate"], "non_decreasing", ignoreMissingProperties=True),
    _spec("waterflow_sliding_window_mode", "WaterFlow", ["layoutMode"], "contains", expectedText="SLIDING_WINDOW"),
    _spec("waterflow_item_constraint_size", "WaterFlow", ["itemConstraintSize"], "exists"),
    _spec("swiper_display_count_non_decreasing", "Swiper", ["displayCount"], "non_decreasing", ignoreMissingProperties=True),
    _spec("swiper_indicator_by_display_count", "Swiper", ["indicator"], "breakpoint_aware", allPropertiesRequired=False, ignoreMissingProperties=True),
    _spec("swiper_margins_for_multi_display", "Swiper", ["prevMargin", "nextMargin"], "breakpoint_aware", allPropertiesRequired=True, ignoreMissingProperties=True),
    _spec("navigation_nav_bar_width_required", "Navigation", ["navBarWidth"], "exists"),
    _spec("flex_grow_shrink_required", "Flex", ["flexGrow", "flexShrink"], "exists"),
    _spec("flex_space_evenly_required", "Flex", ["justifyContent"], "contains", expectedText="SpaceEvenly"),
    _spec("flex_wrap_required", "Flex", ["wrap"], "contains", expectedText="Wrap"),
    _spec("row_column_layout_weight_required", "Row", ["layoutWeight"], "exists"),
    _spec("column_layout_weight_required", "Column", ["layoutWeight"], "exists"),
    _spec("row_column_display_priority_required", "Row", ["displayPriority"], "exists"),
    _spec("column_display_priority_required", "Column", ["displayPriority"], "exists"),
    _spec("blank_spacing_required", "Blank", [], "exists"),
    _spec("horizontal_scroll_required", "Scroll", ["scrollable"], "contains", expectedText="Horizontal"),
]

SPEC_BY_CHECK = {item["check"]: item for item in SPECS}

TEXT_CHECKS = {
    "module_device_types_multi_device", "breakpoint_ranges_standard", "breakpoint_no_hardcoded_width",
    "breakpoint_source_standard", "breakpoint_listener_source_standard", "breakpoint_listener_after_load_content",
    "folderstack_fullscreen", "folderstack_upper_items_ids", "custom_hover_fold_and_landscape",
    "custom_hover_crease_region_api", "custom_hover_fold_listener_cleanup", "web_container_size_by_breakpoint",
    "web_breakpoint_sync_source", "web_media_query_breakpoints_standard", "web_vertical_breakpoint_aspect_ratio",
    "gridrow_no_dynamic_constraint_size_centering", "aspect_ratio_by_breakpoint",
}

MANUAL_CHECKS = {
    "flex_grow_shrink_required", "navigation_nav_bar_width_required", "gridcol_offset_required",
    "flex_space_evenly_required", "flex_wrap_required", "row_column_layout_weight_required",
    "column_layout_weight_required", "row_column_display_priority_required",
    "column_display_priority_required", "horizontal_scroll_required", "waterflow_item_constraint_size",
}
