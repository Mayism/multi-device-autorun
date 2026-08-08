import { DarkModeToggle, MergeArrow, NoticeToggle, SingleArrow } from '../../components/SettingComponents';
import { checkUpdateAndShowDialog } from 'check_app_update';
import { ThemeController } from '../../controller/ThemeController';
import { UserInfo } from 'login';

@Builder
export function SettingBuilder() {
  Setting();
}
let themeController: ThemeController = ThemeController.instance;
@ComponentV2
export struct Setting {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();
  private userInfo: UserInfo = UserInfo.instance;

  build() {
    NavDestination() {
      Column(){
        Scroll(){
          Column({ space: 17 }) {
            SingleArrow({
              text: '保密设置',
            })
              .onClick(() => {
                this.appPathStack.pushPathByName('SecretSetting', undefined);
              });

            SingleArrow({
              text: '隐私设置',
            })
              .onClick(() => {
                this.appPathStack.pushPathByName('PrivacySetting', undefined);
              });

            NoticeToggle({
              text: '通知开关'
            });

            DarkModeToggle()

            MergeArrow({
              text1: '检测版本',
              text1Click: () => {
                checkUpdateAndShowDialog(this.getUIContext());
              },
              text2: '关于我们',
              text2Click: () => {
                this.appPathStack.pushPathByName('AboutUs', undefined);
              },
            });

            Blank()
              .layoutWeight(1)

            if (this.userInfo.isLogin){
              Button('退出登录')
                .width('100%')
                .height(40)
                .fontWeight(FontWeight.Medium)
                .backgroundColor($r('sys.color.comp_background_tertiary'))
                .fontColor($r('sys.color.font_primary'))
                .margin({
                  bottom: 44,
                })
                .onClick(() => {
                  this.appPathStack.pushPathByName('LogOutDialog', undefined);
                });
            }
          }
          .width('100%')
        }
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
      }
      .height('100%')
      .padding({
        top: 10,
        left: $r('sys.float.padding_level8'),
        right: $r('sys.float.padding_level8'),
      })
    }
    .backgroundColor($r('sys.color.background_secondary'))
    .title('设置');
  }
}


