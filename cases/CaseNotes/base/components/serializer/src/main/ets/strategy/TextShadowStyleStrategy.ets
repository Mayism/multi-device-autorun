import IStyleStrategy from './IStyleStrategy';
import { SerializedStyledStringValue } from '../types/Types';

interface SerializedTextShadowStyle extends SerializedStyledStringValue {
  textShadow: Array<ShadowOptions>;
}


export class TextShadowStyleStrategy implements IStyleStrategy<TextShadowStyle, SerializedTextShadowStyle> {
  serialize(value: TextShadowStyle): SerializedTextShadowStyle {
    return {
      textShadow: value.textShadow,
    };
  }

  deserialize(data: SerializedTextShadowStyle): TextShadowStyle {
    return new TextShadowStyle(data.textShadow);
  }
}