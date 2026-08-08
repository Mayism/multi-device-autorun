import { SingleArrow } from '../../components/SettingComponents';

@Builder
export function FeedBackChooseBuilder() {
  FeedBackChoose();
}

@ComponentV2
export struct FeedBackChoose {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();

  build() {
    NavDestination() {
      Column({ space: 17 }) {
        SingleArrow({
          text: '反馈问题',
        })
          .onClick(() => {
            this.appPathStack.pushPathByName('FeedBackPage', undefined);
          });

        SingleArrow({
          text: '反馈记录',
        })
          .onClick(() => {
            this.appPathStack.pushPathByName('FeedbackRecordPage', undefined);
          });
      }
      .width('100%')
      .height('100%')
      .padding({
        top: 10,
        left: $r('sys.float.padding_level8'),
        right: $r('sys.float.padding_level8'),
      })
    }
    .backgroundColor($r('sys.color.background_secondary'))
    .title('意见反馈');
  }
}


