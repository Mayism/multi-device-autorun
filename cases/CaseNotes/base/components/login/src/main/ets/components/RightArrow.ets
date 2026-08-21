@Builder
export function rightArrow (){
  SymbolGlyph($r('sys.symbol.chevron_right'))
    .fontColor([$r('sys.color.ohos_id_color_foreground')])
    .opacity(0.3)
    .fontSize('24vp');
}
