# graphic_text_layout_ohos

图文混排（商品详情页）Flutter 鸿蒙（flutter-ohos）示例工程，移植自
`E:\flutter\multidevice_flutter\lib\graphic_text_layout`，并保留其完整的一多适配能力。

## 一多适配设计

断点系统基于 `hadss_adaptive_layout`（WidthBreakpoint：xs=320 / sm=600 / md=840 / lg=1440 / xl），
窗口尺寸/折叠形态变化时通过回调驱动页面重建。

| 宽度断点 | 典型设备 | 布局 | 图片区域 |
|---|---|---|---|
| xs / sm | 手机（竖屏、分屏） | 垂直布局：图上文下，整页滚动 | 高度 60%，clamp(150, 400) 保证分屏可用 |
| md | 折叠屏展开、平板竖屏 | 水平布局：图左文右分栏 | 宽度占比 60% |
| lg / xl | 平板横屏、PC / 2in1 | 水平布局：图左文右分栏 | 宽度占比 50% |

- 水平布局下文字区独立滚动（`PageStorageKey` 保持滚动位置）；
- 垂直/水平切换由断点回调自动完成，支持折叠屏开合、分屏拖拽实时切换；
- 深浅色主题跟随系统（`AppThemes`）。

## 目录结构

```
lib/
├── main.dart                              # 入口，MaterialApp + 深/浅主题
├── AppThemes.dart                         # 亮/暗主题
└── graphic_text_layout/
    ├── graphic_text_layout.dart           # 页面入口
    ├── screens/responsive_home_screen.dart
    ├── utils/
    │   ├── breakpoint_constants.dart      # 断点管理（初始化/回调/销毁）
    │   ├── screen_utils.dart              # 断点判断与图片宽高计算
    │   ├── text_constants.dart            # 文案
    │   └── image_constants.dart           # 图片路径
    └── widgets/
        ├── graphic_text_view.dart         # 响应式布局核心（垂直/水平切换）
        ├── image_container.dart           # 图片容器
        └── text_container.dart            # 价格 + 详情文字卡片
```

## 构建 / 运行

```bash
flutter pub get
flutter run -d <设备id>          # 需已完成签名配置
flutter analyze                  # 静态检查
flutter test                     # 冒烟测试
```

未签名验证编译（不安装到设备）：

```bash
cd ohos
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-sign
# 产物：ohos/entry/build/default/outputs/default/entry-default-unsigned.hap
```

## 签名说明

`ohos/build-profile.json5` 中 `signingConfigs` 为空。本机已有的调试证书 profile
（`C:\Users\X-MAN\.ohos\config\*.p7b`）均绑定其它 bundleName，与本项目
`com.example.graphic_text_layout_ohos` 不匹配，因此 `flutter build hap` 签名阶段会失败。

签名方法（二选一）：

1. DevEco Studio 打开 `ohos` 目录 → File → Project Structure → Signing Configs，
   勾选 Automatically generate signature，为当前 bundleName 自动生成调试签名；
2. 临时复用参考工程 `multidevice_flutter` 的签名材料：把 `AppScope/app.json5`
   的 bundleName 改为 `com.example.adaption_flutter`，并拷贝参考工程的
   `signingConfigs`（注意会与参考工程安装冲突，验证后请改回）。

## 已验证

- `flutter analyze`：0 error（仅 3 条 info 级 lint）
- `flutter test`：冒烟测试通过
- hvigor `--no-sign` 全量构建：`entry-default-unsigned.hap` 构建成功
  （compatibleSdkVersion 已对齐本机 DevEco SDK：6.1.1(24) / API 24）
