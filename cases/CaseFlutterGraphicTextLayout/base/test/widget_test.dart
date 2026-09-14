// 图文混排页面冒烟测试：验证入口可构建并渲染价格文案
import 'package:flutter_test/flutter_test.dart';

import 'package:graphic_text_layout_ohos/main.dart';

void main() {
  testWidgets('GraphicTextLayout smoke test', (WidgetTester tester) async {
    // Build our app and trigger a frame.
    await tester.pumpWidget(const GraphicTextLayoutApp());

    // 断点系统初始化为异步，等待初始化完成
    await tester.pumpAndSettle(const Duration(milliseconds: 300));

    // 验证价格与详情标题渲染出来
    expect(find.text('￥11499'), findsOneWidget);
    expect(find.text('新机详情'), findsOneWidget);
  });
}
