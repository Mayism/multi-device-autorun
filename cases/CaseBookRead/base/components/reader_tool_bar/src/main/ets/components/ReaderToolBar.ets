import { AppStorageV2 } from '@kit.ArkUI';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { baseActionSheet } from 'base_common';
import { UserInfo } from 'base_common';
import { SelectState } from './SelectState';

@ComponentV2
export struct ReaderToolBar {
  @Param @Require lockedStatus: boolean[] = [];
  @Param @Require curChapterId: number = 0
  @Local isShowSetTool: boolean = false;
  @Local isShowLight: boolean = false;
  @Local screenLight: number = 0.5;
  @Local fontSize: number = 0;
  @Local autoLight: boolean = true;
  @Consumer('nightMode') nightMode: boolean = false;
  @Local price: number = 10
  @Local isReadingBySingle: boolean = true;
  @Local selectState: SelectState = AppStorageV2.connect(SelectState, () => new SelectState())!;
  @Local userInfo: UserInfo = AppStorage.get<UserInfo>('userInfo')!
  private context: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
  private windowClass = this.context.windowStage.getMainWindowSync();

  aboutToAppear(): void {
    this.nightMode = AppStorage.get<boolean>('bookNightMode') ??
      this.context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK
  }

  @Builder
  fontChoice(name: string, filePath: string, index: number) {
    Text(name)
      .padding({
        left: 24,
        right: 24,
        top: 6,
        bottom: 6
      })
      .borderRadius(14)
      .fontColor(this.selectState.fontSelectedIndex === index ? $r('sys.color.ohos_id_color_text_primary_contrary') :
        (this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.40per_000000')))
      .fontSize(14)
      .fontWeight('medium')
      .backgroundColor(this.selectState.fontSelectedIndex === index ? $r('sys.color.ohos_id_color_handup') :
        this.nightMode ? $r('app.color.5per_ffffff') : $r('app.color.5per_000000'))
      .onClick(() => {
        this.selectState.fontSelectedIndex = index
      })
  }

  @Builder
  buildSettingSheet() {
    Column({ space: 25 }) {
      Row({ space: 8 }) {
        Text('字号')
          .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))

        Image(this.nightMode ? $r('app.media.ic_font_sub_dark') : $r('app.media.ic_font_sub'))
          .height(28)
          .width(48)

        Text(this.fontSize.toString())
          .fontSize(16)
          .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))

        Image(this.nightMode ? $r('app.media.ic_font_add_dark') : $r('app.media.ic_font_add'))
          .height(28)
          .width(48)
      }

      Row({ space: 8 }) {
        Text('字体')
          .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))
        Row({ space: 10 }) {
          this.fontChoice('系统', 'fonts/HarmonyOS_Sans_Regular.ttf', 0)
          this.fontChoice('鸿蒙黑体', 'fonts/HarmonyOS_Sans_Black.ttf', 1)
        }
      }

      Row({ space: 8 }) {
        Text('行间')
          .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))
        Row({ space: 12 }) {
          Image(this.nightMode ? $r('app.media.ic_space_min_dark') : $r('app.media.ic_space_min'))
            .height(24)
            .width(24)

          Slider({
            min: 1,
            max: 4,
            step: 0.1,
            style: SliderStyle.InSet
          })
            .blockColor($r('app.color.font_modifier_inner_color'))
            .trackColor(this.nightMode ? $r('app.color.10per_ffffff') : $r('app.color.10per_000000'))
            .selectedColor($r('app.color.slider_selected_color'))
            .layoutWeight(1)

          Image(this.nightMode ? $r('app.media.ic_space_max_dark') : $r('app.media.ic_space_max'))
            .height(24)
            .width(24)
        }
        .layoutWeight(1)

      }
      .width('100%')

      Row({ space: 12 }) {
        Text('背景')
          .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))
        Row({ space: 8 }) {
          this.colorCircle($r('app.color.reader_view_background_0'), 0)
          this.colorCircle($r('app.color.reader_view_background_1'), 1)
          this.colorCircle($r('app.color.reader_view_background_2'), 2)
        }
        .justifyContent(FlexAlign.SpaceBetween)
        .layoutWeight(1)
      }

      Row({ space: 12 }) {
        Text('翻页')
          .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))
        Row({ space: 10 }) {
          Text('仿真')
            .padding({
              left: 24,
              right: 24,
              top: 6,
              bottom: 6
            })
            .borderRadius(14)
            .fontColor(this.selectState.isReadingBySwiper ? $r('sys.color.ohos_id_color_text_secondary') :
              $r('sys.color.ohos_id_color_text_primary_contrary'))
            .fontSize(14)
            .fontWeight('medium')
            .backgroundColor(this.selectState.isReadingBySwiper ? $r('sys.color.ohos_id_color_button_normal') :
              $r('sys.color.ohos_id_color_handup'))

          Text('横滑')
            .padding({
              left: 24,
              right: 24,
              top: 6,
              bottom: 6
            })
            .borderRadius(14)
            .fontColor(this.selectState.isReadingBySwiper ? $r('sys.color.ohos_id_color_text_primary_contrary') :
              (this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.40per_000000')))
            .fontSize(14)
            .fontWeight('medium')
            .backgroundColor(this.selectState.isReadingBySwiper ? $r('sys.color.ohos_id_color_handup') :
              this.nightMode ? $r('app.color.5per_ffffff') : $r('app.color.5per_000000'))
        }
      }
    }
    .padding({
      top: 25,
      bottom: 25,
      left: 24,
      right: 24
    })
    .alignItems(HorizontalAlign.Start)

  }

  @Builder
  buildLightModifySlider() {
    Row({ space: 5 }) {
      Image(this.nightMode ? $r('app.media.light_min_dark') : $r('app.media.light_min'))
        .height(16)
        .width(16)

      Slider({
        min: 0,
        max: 1,
        value: this.screenLight!!,
        step: 0.2,
        style: SliderStyle.OutSet
      })
        .blockColor($r('app.color.font_modifier_inner_color'))
        .trackColor(this.nightMode ? $r('app.color.10per_ffffff') : $r('app.color.10per_000000'))
        .selectedColor($r('app.color.slider_selected_color'))
        .onChange((value: number) => {
          try {
            this.autoLight = false
            this.screenLight = value;
            this.windowClass.setWindowBrightness(this.screenLight);
          } catch (error) {
            console.error('ReaderToolBar', ` setWindowBrightness error = ${JSON.stringify(error)}`)
          }

        })
        .layoutWeight(1)

      Image(this.nightMode ? $r('app.media.light_min_dark') : $r('app.media.light_min'))
        .height(20)
        .width(20)
    }
    .width('100%')
    .justifyContent(FlexAlign.SpaceBetween)
    .height(50)
  }

  @Builder
  colorCircle(color: Resource, index: number) {
    Column()
      .height(28)
      .width(56)
      .backgroundColor(color)
      .borderRadius(14)
      .onClick(() => {
        try {
          this.context.resourceManager.getColor(color.id).then((value) => {
            // 转成16进制
            this.selectState.colorSelectedIndex = index;
          })
        } catch (e) {
          console.error('Failed to getColor. Cause: ' + JSON.stringify(e));
        }

      })
      .borderColor($r('sys.color.ohos_fa_handup'))
      .borderWidth(this.selectState.colorSelectedIndex === index ? 0.1 : 0)
  }

  @Builder
  buildModifyColor() {
    Column() {
      // 亮度调整
      this.buildLightModifySlider();

      Row() {
        Text('系统亮度')
          .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))
        Toggle({ type: ToggleType.Switch, isOn: $$this.autoLight })
          .selectedColor($r('sys.color.multi_color_08'))
          .onChange((isOn) => {
            try {
              this.windowClass.setWindowBrightness(isOn ? -1 : this.screenLight);
            }  catch (error) {
              console.error('ReaderToolBar', ` windowClass setWindowBrightness error = ${JSON.stringify(error)}`)
            }
          })
      }
      .width('100%')
      .justifyContent(FlexAlign.Start)

    }
    .justifyContent(FlexAlign.SpaceBetween)
    .width('100%')
    .padding({ top: 10, bottom: 16, left: 18, right: 18 })
    .height(116)
  }

  build() {
    Column() {
      if (this.isShowLight) {
        this.buildModifyColor();
      }

      if (this.isShowSetTool) {
        this.buildSettingSheet();
      }

      Row() {
        Column({ space: 2 }) {
          Image(this.nightMode ? $r('app.media.ic_public_lists_dark') : $r('app.media.ic_public_lists'))
            .width(24)
            .height(24)

          Text('目录')
            .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))
        }
        .onClick(() => {
          baseActionSheet.show({
            id: 'catalog',
            title: { title: '目录' },
            height: '90%',
            preferType: SheetType.CENTER,
            backgroundColor: this.nightMode ? $r('app.color.100per_000000') : $r('app.color.100per_f1f3f5'),
            customContent: () => {
            },
          })
        })

        Column({ space: 2 }) {
          Image(this.nightMode ?
            (this.isShowLight ? $r('app.media.ic_ict_activate_on_dark') : $r('app.media.ic_light_dark')) :
            (this.isShowLight ? $r('app.media.ic_ict_activate_on') : $r('app.media.ic_light')))
            .width(24)
            .height(24)

          Text('亮度')
            .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))
        }
        .onClick(() => {
          this.isShowSetTool = false
          this.isShowLight = !this.isShowLight
        })

        Column({ space: 2 }) {
          Image(this.nightMode ? $r('app.media.night_mode_dark') : $r('app.media.night_mode'))
            .width(24)
            .height(24)

          Text(this.nightMode ? '日间' : '夜间')
            .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))
        }
        .onClick(() => {
          this.nightMode = !this.nightMode
          AppStorage.setOrCreate<boolean>('bookNightMode', this.nightMode)
        })

        Column({ space: 2 }) {
          Image(this.nightMode ?
            (this.isShowSetTool ? $r('app.media.icon_setting_on_dark') : $r('app.media.book_setting_dark')) :
            this.isShowSetTool ? $r('app.media.icon_setting_on') : $r('app.media.book_setting'))
            .width(24)
            .height(24)

          Text('设置')
            .fontColor(this.nightMode ? $r('app.color.90per_ffffff') : $r('app.color.60per_182431'))
        }
        .onClick(() => {
          this.isShowSetTool = !this.isShowSetTool
          this.isShowLight = false
        })
      }
      .width('100%')
      .padding({
        left: 25,
        right: 25,
        bottom: 30,
        top: 15
      })
      .justifyContent(FlexAlign.SpaceBetween)
    }
    .borderRadius((this.isShowSetTool || this.isShowLight) ? { topLeft: 16, topRight: 16 } : 0)
    .width('100%')
    .backgroundColor(this.nightMode ? $r('app.color.100per_000000') : $r('app.color.100per_f1f3f5'))
    .align(Alignment.BottomEnd)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}