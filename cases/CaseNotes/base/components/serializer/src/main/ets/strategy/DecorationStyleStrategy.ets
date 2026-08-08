import IStyleStrategy from './IStyleStrategy';
import { SerializedStyledStringValue } from '../types/Types';

interface SerializedDecorationStyle extends SerializedStyledStringValue {
  type: TextDecorationType;
  color?: ResourceColor;
  style?: TextDecorationStyle;
  thicknessScale?: number;
  options?: DecorationOptions;
}


export class DecorationStyleStrategy implements IStyleStrategy<DecorationStyle, SerializedDecorationStyle> {
  serialize(value: DecorationStyle): SerializedDecorationStyle {
    return {
      type: value.type,
      color: value.color,
      style: value.style,
      thicknessScale: value.thicknessScale,
      options: value.options,
    };
  }

  deserialize(data: SerializedDecorationStyle): DecorationStyle {
    return new DecorationStyle({
      type: data.type,
      color: data.color,
      style: data.style,
      thicknessScale: data.thicknessScale,
    });
  }
}