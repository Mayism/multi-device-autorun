import { ThemeController } from '../controller/ThemeController';

@ComponentV2
export struct EmptyTrash  {
  themeController: ThemeController = ThemeController.instance;
  build() {
    Column() {
      Image($r('app.media.empty_notes'))
        .width(120)
        .height(120)

      Text('回收站内暂无内容')
        .fontSize(12)
        .fontColor($r('sys.color.font_tertiary'))
    }
    .width('100%')
    .height(100)
    .padding({
      left: '4%',
      right: '4%',
    })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ top: 70 })
  }
}