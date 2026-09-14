import 'package:flutter/material.dart';
import 'package:graphic_text_layout_ohos/AppThemes.dart';
import 'package:graphic_text_layout_ohos/graphic_text_layout/widgets/graphic_text_view.dart';

class ResponsiveHomeScreen extends StatefulWidget {
  const ResponsiveHomeScreen({super.key});

  @override
  State<ResponsiveHomeScreen> createState() => _ResponsiveHomeScreenState();
}

class _ResponsiveHomeScreenState extends State<ResponsiveHomeScreen> {
  @override
  void initState() {
    super.initState();
    // 不设置SystemUI模式，使用默认设置
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 不设置SystemUiOverlayStyle，让debug信息正常显示
  }

  @override
  Widget build(BuildContext context) {
    final brightness = MediaQuery.of(context).platformBrightness;
    final backgroundColor = brightness == Brightness.light
        ? AppThemes.lightTheme.scaffoldBackgroundColor
        : AppThemes.darkTheme.scaffoldBackgroundColor;

    return Scaffold(
      backgroundColor: backgroundColor, // 统一设置Scaffold背景色
      body: SafeArea(
        child: Container(
          color: backgroundColor, // 确保SafeArea内也使用相同背景色
          child: GraphicTextView(),
        ),
      ),
    );
  }
}
