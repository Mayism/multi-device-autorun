import { BaseTextStyleModifier } from '../styles/TextStyleModifier';
import { WindowUtil } from '../utils/WindowUtil';

class SheetConstant {
  // 图片尺寸
  static readonly IMAGE_SIZE: Length = 40;
  // 通用间距
  static readonly SPACE: Length = 16;
  // 外边距
  static readonly MARGIN: Length = 8;
  // 背景颜色
  static readonly BG_COLOR: ResourceColor = '#3F7EF7';
  // 标题字体大小
  static readonly TITLE_SIZE: Length = $r('sys.float.Body_L');
  // 标题字体颜色
  static readonly FONT_COLOR: ResourceColor = $r('sys.color.font_on_primary');
  // 全比例
  static readonly FULL_PERCENT: Length = '100%';
}

@ComponentV2
export struct ConfirmSheet {
  // 标题文字
  @Param title: string = '标题';
  // 取消回调
  @Event cancel: () => void;
  // 确认回调
  @Event confirm: () => void;
  // 自定义布局
  @BuilderParam ui: () => void;

  build() {
    Column() {
      Row() {
        Row() {
          Image($r('app.media.btn_cancel'))
            .width(14)
            .height(14)
            .fillColor($r('sys.color.icon_primary'))
        }
        .width(SheetConstant.IMAGE_SIZE)
        .height(SheetConstant.IMAGE_SIZE)
        .backgroundColor($r('sys.color.comp_background_tertiary'))
        .justifyContent(FlexAlign.Center)
        .borderRadius('50%')
        .onClick(() => {
          this.cancel();
        })

        Text(this.title)
          .attributeModifier(new BaseTextStyleModifier('font_primary/Title_S/Bold'))
          .layoutWeight(1)
          .margin({ left: SheetConstant.MARGIN })

        Row() {
          Image($r('app.media.btn_confirm'))
            .width(14)
            .height(9)
            .fillColor($r('sys.color.icon_primary'))
        }
        .width(SheetConstant.IMAGE_SIZE)
        .height(SheetConstant.IMAGE_SIZE)
        .backgroundColor($r('sys.color.comp_background_tertiary'))
        .justifyContent(FlexAlign.Center)
        .borderRadius('50%')
        .onClick(() => {
          this.confirm();
        })
      }

      this.ui()
    }
    .width(SheetConstant.FULL_PERCENT)
    .padding({
      left: SheetConstant.SPACE,
      right: SheetConstant.SPACE,
      top: SheetConstant.SPACE,
      bottom: WindowUtil.getAvoidArea().bottom,
    })
  }
}