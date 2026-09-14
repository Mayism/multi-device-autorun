import 'package:flutter/material.dart';
import 'package:graphic_text_layout_ohos/AppThemes.dart';
import 'package:graphic_text_layout_ohos/graphic_text_layout/utils/text_constants.dart' as text;

class TextContainer extends StatelessWidget {
  final bool enableScroll;

  const TextContainer({
    super.key,
    this.enableScroll = false,
  });

  static const _contentPadding = EdgeInsets.all(16);
  static const _sectionMargin = EdgeInsets.only(top: 12);

  @override
  Widget build(BuildContext context) {
    final brightness = MediaQuery.of(context).platformBrightness;
    final backgroundColor = brightness == Brightness.light ? AppThemes.lightTheme.scaffoldBackgroundColor : AppThemes.darkTheme.scaffoldBackgroundColor;
    final onSurface = brightness == Brightness.light ? Colors.black : Colors.white;
    final onSurfaceVariant = brightness == Brightness.light ? Colors.grey[600]! : Colors.grey[400]!;
    final priceColor = const Color(0xFFCF0A2C);
    final promotionColor = const Color(0xFFCF0A2C);

    Widget content = Container(
      width: double.infinity,
      color: backgroundColor,
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        children: [
          // qa_ 语义标记：供鸿蒙 ohosTest UiTest 定位（发布版可按 qa_ 前缀移除）
          Semantics(
            label: 'qa_price_section',
            child: _buildSection(
              context: context,
              title: text.TextConstants.price,
              titleStyle: TextStyle(
                fontSize: 25,
                color: priceColor,
                fontWeight: FontWeight.w700,
              ),
              children: [
                const SizedBox(height: 6),
                Text(
                  text.TextConstants.promotion,
                  style: TextStyle(
                    fontSize: 16,
                    color: onSurfaceVariant,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ],
            ),
          ),
          Semantics(
            label: 'qa_details_section',
            child: _buildSection(
              context: context,
              title: text.TextConstants.detailsTitle,
              titleStyle: TextStyle(
                fontSize: 25,
                color: onSurface,
                fontWeight: FontWeight.w600,
              ),
              children: [
                const SizedBox(height: 6),
                Text(
                  text.TextConstants.promotionDetails,
                  style: TextStyle(
                    fontSize: 16,
                    color: promotionColor,
                    fontWeight: FontWeight.w400,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  text.TextConstants.productDescription,
                  style: TextStyle(
                    fontSize: 16,
                    color: onSurfaceVariant,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );

    if (enableScroll) {
      return SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: content,
      );
    }
    return content;
  }

  Widget _buildSection({
    required BuildContext context,
    required String title,
    required TextStyle titleStyle,
    required List<Widget> children,
  }) {
    final brightness = MediaQuery.of(context).platformBrightness;
    final containerColor = brightness == Brightness.light ? AppThemes.lightTheme.cardColor : AppThemes.darkTheme.cardColor;

    return Container(
      width: double.infinity,
      margin: _sectionMargin,
      padding: _contentPadding,
      decoration: BoxDecoration(
        color: containerColor,
        borderRadius: const BorderRadius.all(Radius.circular(8)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: titleStyle),
          ...children,
        ],
      ),
    );
  }
}
