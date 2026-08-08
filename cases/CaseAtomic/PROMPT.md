# 任务：CaseAtomic 分屏窗口适配

请对当前 HarmonyOS ArkUI 工程完成分屏 / 小窗口场景的一多适配。先加载并遵循 `harmonyos-multi-device-adaptation` skill；只修改实现适配所需的业务源码，不修改测试代码、`test_patch.patch`、`golden_patch.patch`、`metadata.json` 或 `build`、`.hvigor`、`oh_modules` 等生成目录。

所有布局判断必须基于**窗口可用宽高和工程既有的响应式能力**，不得根据设备名称、模拟器型号或固定物理像素作判断。保留现有隐私页、首页、登录、视频、导航、滚动和点击行为。

## 验收场景

以下场景会在应用进入系统默认 1/2 分屏后验证：

| 测试用例 | 类型 | 验收目标 |
| --- | --- | --- |
| `should_loginPage_content_scrollable_after_split` | fail_to_pass | 登录页可滚至底部协议勾选框 |
| `should_dialogContent_notOverlap_with_bottomButtons_after_split` | fail_to_pass | 隐私弹窗内容区不与底部按钮重叠 |
| `should_safePage_icon_hidden_after_split` | fail_to_pass | 隐私页图标在分屏下隐藏或保持完整不变形 |
| `should_videoKeepAspectRatio_after_split` | fail_to_pass | 视频画面分屏前后保持宽高比 |
| `should_homeTabBar_fullyVisible_without_scroll_after_split` | pass_to_pass | 首页 Tab 栏无需滚动即可完整可见 |

1. **登录页可滚动（fail_to_pass）**
   - 从隐私页同意后进入“我的”，点击“点击登录”进入登录页；分屏后内容不得被截断。
   - 登录页中的协议 `Checkbox` 初始可在视口外，但向上滚动后必须能够完整进入当前窗口可视区域。
   - 使用正确的可滚动容器与窗口适配，不要通过隐藏内容或固定高度规避。

2. **隐私弹窗内容不遮挡底部按钮（fail_to_pass）**
   - 隐私页点击“取消”打开 `AgreeDialog` 后，弹窗内容区与“退出应用”等底部按钮区域不得重叠。
   - 弹窗内容区应可在受限窗口内滚动，底部操作区保持独立、完整可用。
   - 为弹窗内部的实际 `Scroll` 内容区保留或补充 `.id('ss_agree_dialog_scroll')`，供自动化定位；不要把该 id 放在不反映内容区域边界的外层容器上。

3. **隐私页图标在小窗口中不变形或合理隐藏（fail_to_pass）**
   - `SafePage` 起始图标在全屏时应存在，并使用 `.id('ss_safe_icon')`。
   - 分屏后，图标可以通过空间优先级合理隐藏；若仍显示，必须完整位于窗口可视区域内，且与分屏前的宽高比偏差小于 5%。
   - 不得通过设备型号分支或拉伸图片来处理。

4. **视频画面保持宽高比（fail_to_pass）**
   - 进入“视频”页的精选视频后，当前播放画面必须保留 `.id('ss_video_xcomponent')`。
   - 分屏前后视频画面宽高比偏差必须小于 10%；可随窗口缩放，但不得被拉伸、压扁或因固定尺寸溢出。

5. **首页 Tab 栏完整可见（pass_to_pass）**
   - 隐私页同意进入首页后，在分屏状态下无需先滚动，首页 Tab 栏必须完整位于可视窗口内。
   - 为实际首页底部 Tab 容器保留或补充 `.id('ss_home_tabs')`，不得把 Tab 栏放入会随主内容滚走的区域。

## 实施要求

- 先检查工程中现有窗口、滚动、`SafePage`、`AgreeDialog`、登录页、首页 Tab 和视频组件实现；已有正确能力只验证或复用，避免重复造基础设施。
- 对窗口变窄后的高度受限场景，优先处理滚动边界、固定操作区、安全区和可视区域；对媒体使用正确的 `aspectRatio` 或等价响应式约束。
- 保留自动化依赖的文本入口：“同意”“取消”“退出应用”“我的”“点击登录”“视频”，以及上述四个组件 id。
- 不新增或修改任何测试；不要为了断言硬编码特定屏幕尺寸。
- 完成后检查分屏下上述五项场景，并尽可能执行与工程匹配的编译验证。
