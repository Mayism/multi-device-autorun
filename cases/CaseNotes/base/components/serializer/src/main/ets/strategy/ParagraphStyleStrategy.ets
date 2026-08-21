import IStyleStrategy from './IStyleStrategy';
import { LengthMetrics } from '@kit.ArkUI';
import { SerializedStyledStringValue } from '../types/Types';

interface SerializedParagraphStyle extends SerializedStyledStringValue {
  textAlign?: TextAlign;
  textIndent?: number;
  maxLines?: number;
  overflow?: TextOverflow;
  wordBreak?: WordBreak;
}


export class ParagraphStyleStrategy implements IStyleStrategy<ParagraphStyle, SerializedParagraphStyle> {
  serialize(value: ParagraphStyle): SerializedParagraphStyle {
    return {
      textAlign: value.textAlign,
      textIndent: value.textIndent,
      maxLines: value.maxLines,
      overflow: value.overflow,
      wordBreak: value.wordBreak,
    };
  }

  deserialize(data: SerializedParagraphStyle): ParagraphStyle {
    return new ParagraphStyle({
      textAlign: data.textAlign,
      textIndent: LengthMetrics.px(data.textIndent),
      maxLines: data.maxLines,
      overflow: data.overflow,
      wordBreak: data.wordBreak,
    });
  }
}