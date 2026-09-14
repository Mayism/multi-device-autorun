import 'package:flutter/material.dart';

import 'AppThemes.dart';
import 'graphic_text_layout/graphic_text_layout.dart';

void main() {
  runApp(const GraphicTextLayoutApp());
}

/// 图文混排一多适配示例入口
class GraphicTextLayoutApp extends StatelessWidget {
  const GraphicTextLayoutApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '图文混排一多适配',
      debugShowCheckedModeBanner: false,
      theme: AppThemes.lightTheme,
      darkTheme: AppThemes.darkTheme,
      home: const GraphicTextLayout(),
    );
  }
}
