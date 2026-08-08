import { CommonConstants } from '../constants/CommonConstants';
import { BaseTextStyleModifier } from '../styles/TextStyleModifier';
import { PopViewUtils } from '../utils/PopViewUtils';
import { ConfirmSheet } from './ConfirmSheet';

@ObservedV2
export class SettingFontParams {
  @Trace index: number;
  confirm: (index: number) => void;

  constructor(index: number, confirm: (index: number) => void) {
    this.index = index;
    this.confirm = confirm;
  }
}

@ComponentV2
export struct SettingFont {
  @Require @Param params: SettingFontParams;

  build() {
    Column({ space: CommonConstants.SPACE_26 }) {
      Text('字体大小看这里').attributeModifier(new BaseTextStyleModifier('font_primary/Subtitle_L/Regular'))
      Row() {
        Text('A').attributeModifier(new BaseTextStyleModifier('font_primary/Body_L/Regular')).height(20)
          .onClick(() => {
            this.params.index = 0;
          })

        Column({ space: CommonConstants.SPACE_10 }) {
          Slider({
            value: this.params.index,
            step: 1,
            min: 0,
            max: 1,
            style: SliderStyle.InSet,
            direction: Axis.Horizontal,
          })
            .padding(0)
            .height(20)
            .showSteps(false)
            .onChange((value: number) => {
              this.params.index = value;
            })

          Row() {
            Text('标准').attributeModifier(new BaseTextStyleModifier('font_secondary/Caption_M/Regular'))
            Text('大').attributeModifier(new BaseTextStyleModifier('font_secondary/Caption_M/Regular'))
          }
          .padding({ left: CommonConstants.SPACE_6, right: CommonConstants.SPACE_6 })
          .width(CommonConstants.FULL_PERCENT)
          .justifyContent(FlexAlign.SpaceBetween)
        }
        .layoutWeight(1)
        .margin({ left: CommonConstants.SPACE_6, right: CommonConstants.SPACE_6 })


        Text('A').attributeModifier(new BaseTextStyleModifier('font_primary/Subtitle_L/Regular')).height(20)
          .onClick(() => {
            this.params.index = 1;
          })
      }
      .justifyContent(FlexAlign.SpaceBetween)
      .alignItems(VerticalAlign.Top)
    }
    .padding({ top: CommonConstants.SPACE_16 })
  }
}

@Builder
export function settingFontBuilder(params: SettingFontParams) {
  ConfirmSheet({
    title: '字号设置',
    cancel: () => {
      PopViewUtils.closeSheet();
    },
    confirm: () => {
      params.confirm(params.index);
      PopViewUtils.closeSheet();
    },
  }) {
    SettingFont({ params: params })
  }
}