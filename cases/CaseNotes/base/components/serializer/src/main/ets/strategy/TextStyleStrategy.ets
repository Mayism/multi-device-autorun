import IStyleStrategy from './IStyleStrategy';
import { LengthMetrics } from '@kit.ArkUI';
import { SerializedStyledStringValue } from '../types/Types';

export interface SerializedTextStyle extends SerializedStyledStringValue {
  fontColor?: ResourceColor;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: FontStyle;
  strokeWidth?: number;
  strokeColor?: ResourceColor;
}

/**
 * 策略实现：专门处理 TextStyle
 */
export class TextStyleStrategy implements IStyleStrategy<TextStyle, SerializedTextStyle> {
  serialize(value: TextStyle): SerializedTextStyle {
    return {
      fontColor: value.fontColor,
      fontFamily: value.fontFamily,
      fontSize: value.fontSize,
      fontWeight: TextStyleStrategy.serializeFontWeight(value.fontWeight),
      fontStyle: value.fontStyle,
    };
  }

  deserialize(data: SerializedTextStyle): TextStyle {
    return new TextStyle({
      fontColor: data.fontColor,
      fontFamily: data.fontFamily,
      fontSize: LengthMetrics.fp(data.fontSize),
      fontWeight: data.fontWeight,
      fontStyle: TextStyleStrategy.deserializeFontStyle(data.fontStyle),
      strokeWidth: LengthMetrics.vp(data.strokeWidth),
      strokeColor: data.strokeColor,
    });
  }

  private static serializeFontWeight(fontWeight: number | undefined) {
    if (!fontWeight) {
      return 400
    }
    if (typeof fontWeight === 'string') {
      let weight = parseInt(fontWeight, 10)
      switch (weight) {
        case 3:
          return 400
        case 9:
          return 700
        case 10:
          return 400
        default:
          return 400
      }
    }
    return 400
  }

  private static deserializeFontStyle(fontStyle: FontStyle | undefined) {
    if (!fontStyle) {
      return FontStyle.Normal
    }
    if (typeof fontStyle === 'string') {
      if (fontStyle === '1') {
        return FontStyle.Italic
      }
      return FontStyle.Normal
    }
    return FontStyle.Normal
  }
}