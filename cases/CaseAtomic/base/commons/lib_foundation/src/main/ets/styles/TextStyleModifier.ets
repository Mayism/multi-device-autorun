export class BaseTextStyleModifier implements AttributeModifier<TextAttribute> {
  private _fontSizeMap: Record<string, ResourceStr> = {
    'BODY_M': $r('sys.float.Body_M'),
    'BODY_S': $r('sys.float.Body_S'),
    'BODY_L': $r('sys.float.Body_L'),
    'SUBTITLE_M': $r(`sys.float.Subtitle_M`),
    'SUBTITLE_L': $r(`sys.float.Subtitle_L`),
    'SUBTITLE_S': $r(`sys.float.Subtitle_S`),
    'TITLE_M': $r(`sys.float.Title_M`),
    'TITLE_S': $r(`sys.float.Title_S`),
    'CAPTION_M': $r(`sys.float.Caption_M`),
  };
  private _fontColorMap: Record<string, ResourceStr> = {
    'FONT_PRIMARY': $r('sys.color.font_primary'),
    'FONT_TERTIARY': $r('sys.color.font_tertiary'),
    'FONT_SECONDARY': $r('sys.color.font_secondary'),
    'FONT_ON_PRIMARY': $r('sys.color.font_on_primary'),
    'FONT_ON_SECONDARY': $r('sys.color.font_on_secondary'),
    'WARNING': $r('sys.color.warning'),
    'FONT_EMPHASIZE': $r('sys.color.font_emphasize'),
  };
  private _fontWeightMap: Record<string, FontWeight> = {
    'REGULAR': FontWeight.Regular,
    'BOLD': FontWeight.Bold,
    'MEDIUM': FontWeight.Medium,
  };
  private _fontSize: ResourceStr = '';
  private _fontColor: ResourceStr = '';
  private _fontWeight: FontWeight = FontWeight.Regular;

  constructor(description?: string) {
    let styleDescription = description?.toUpperCase() as string;
    this._fontColor = this._fontColorMap[styleDescription.split('/')[0]] ?? styleDescription.split('/')[0];
    this._fontSize = this._fontSizeMap[styleDescription.split('/')[1]] ?? styleDescription.split('/')[1];
    this._fontWeight = this._fontWeightMap[styleDescription.split('/')[2]] as FontWeight;
  }

  applyNormalAttribute(instance: TextAttribute): void {
    instance
      .fontColor(this._fontColor)
      .fontWeight(this._fontWeight)
      .fontSize(this._fontSize)
  }
}