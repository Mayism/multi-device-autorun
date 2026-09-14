import 'package:flutter/material.dart';
import 'package:graphic_text_layout_ohos/AppThemes.dart';
import 'package:graphic_text_layout_ohos/graphic_text_layout/widgets/image_container.dart';
import 'package:graphic_text_layout_ohos/graphic_text_layout/widgets/text_container.dart';

class GraphicTextView extends StatefulWidget {
  const GraphicTextView({super.key});

  @override
  State<GraphicTextView> createState() => _GraphicTextViewState();
}

class _GraphicTextViewState extends State<GraphicTextView> {
  final ScrollController _verticalScrollController = ScrollController();

  @override
  void dispose() {
    _verticalScrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final brightness = MediaQuery.of(context).platformBrightness;
    final backgroundColor = brightness == Brightness.light
        ? AppThemes.lightTheme.scaffoldBackgroundColor
        : AppThemes.darkTheme.scaffoldBackgroundColor;

    return Container(
      color: backgroundColor,
      child: _buildVerticalLayout(),
    );
  }

  Widget _buildVerticalLayout() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final availableHeight = constraints.maxHeight;
        final imageHeight = availableHeight * 0.6;

        return Container(
          height: availableHeight,
          child: SingleChildScrollView(
            controller: _verticalScrollController,
            physics: const AlwaysScrollableScrollPhysics(),
            key: const PageStorageKey('vertical_scroll'),
            child: Column(
              children: [
                Container(
                  height: imageHeight,
                  child: const ImageContainer(),
                ),
                Container(
                  padding: const EdgeInsets.only(left: 8, right: 8),
                  child: const TextContainer(
                    enableScroll: false,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
