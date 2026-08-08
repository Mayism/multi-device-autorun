import { UserInfo } from 'login';
import { ThemeController } from '../controller/ThemeController';

@Builder
export function LogOutDialogBuilder() {
  LogOutDialog();
}

/**
 * 设置-退出登录弹窗
 */
@ComponentV2
export struct LogOutDialog {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();
  private themeController: ThemeController = ThemeController.instance
  private userInfo: UserInfo = UserInfo.instance;

  build() {
    NavDestination() {
      Stack({ alignContent: Alignment.Center }) {
        Column({ space: 18 }) {
          Text('账号退出登录')
            .fontSize(20)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.font_primary'))

          Text('请确认是否退出当前账户？')
            .fontColor($r('sys.color.font_primary'))
            .fontSize(14)

          Flex({justifyContent: FlexAlign.SpaceAround}){
            Row(){
              Text('取消')
                .fontColor($r('sys.color.icon_emphasize'))
                .fontSize(16)
            }
            .justifyContent(FlexAlign.Center)
            .width('50%')
            .onClick(() => {
              this.appPathStack.pop();
            })

            Row(){
              Text('确定')
                .fontColor($r('sys.color.icon_emphasize'))
                .fontSize(16)
            }
            .justifyContent(FlexAlign.Center)
            .width('50%')
            .onClick(() => {
              this.userInfo.logOut();
              this.appPathStack.pop();
            })
          }
          .padding({
            top: 10
          })
        }
        .justifyContent(FlexAlign.Center)
        .backgroundColor(this.themeController.dialogBgWhite)
        .borderRadius(32)
        .height(139)
        .width('92%')
      }
      .height('100%')
      .width('100%')
      .onClick(() => {
        this.appPathStack.pop();
      })
    }
    .backgroundColor($r('sys.color.mask_fourth'))
    .hideTitleBar(true)
    .mode(NavDestinationMode.DIALOG);
  }
}