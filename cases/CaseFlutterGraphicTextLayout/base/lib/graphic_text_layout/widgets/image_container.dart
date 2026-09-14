import 'package:flutter/material.dart';
import 'package:graphic_text_layout_ohos/AppThemes.dart';
import 'package:graphic_text_layout_ohos/graphic_text_layout/utils/image_constants.dart';

/// 图片容器组件
///
/// 显示产品图片，支持响应式尺寸调整
class ImageContainer extends StatelessWidget {
  /// 图片宽度
  final double? width;

  /// 图片高度
  final double? height;

  const ImageContainer({
    super.key,
    this.width,
    this.height,
  });

  @override
  Widget build(BuildContext context) {
    final brightness = MediaQuery.of(context).platformBrightness;
    final backgroundColor = brightness == Brightness.light
        ? AppThemes.lightTheme.scaffoldBackgroundColor
        : AppThemes.darkTheme.scaffoldBackgroundColor;
    final containerColor = brightness == Brightness.light
        ? AppThemes.lightTheme.cardColor
        : AppThemes.darkTheme.cardColor;

    final screenWidth = MediaQuery.of(context).size.width;
    final screenHeight = MediaQuery.of(context).size.height;

    // 使用传入的宽高，如果没有则使用默认值
    final imageWidth = width ?? screenWidth;
    final imageHeight = height ?? screenHeight;

    // qa_ 语义标识内置于组件自身：无论外层代码如何调整/删改，
    // 标识始终随图片区存在（供鸿蒙 ohosTest UiTest 定位，发布版可按 qa_ 前缀移除）
    return Semantics(
      label: 'qa_image_container',
      child: Container(
        color: backgroundColor,
        child: Center(
          child: Container(
            width: imageWidth,
            height: imageHeight,
            decoration: BoxDecoration(
              color: containerColor,
            ),
            child: Image.asset(
              ImageConstants.picturePath,
              fit: BoxFit.contain,
              width: double.infinity,
              height: double.infinity,
            ),
          ),
        ),
      ),
    );
  }
}
