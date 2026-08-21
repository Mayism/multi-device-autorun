import { COMMON_SERVICE, MinePageCommonService } from '../../constants/MineUiConstants';
import { UserInfo } from 'login';
import { ContactItem, MineItem } from '../../components/MineItem';

@Builder
export function MineViewBuilder() {
  MineView();
}

@ComponentV2
export struct MineViewContent {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();
  private userInfo: UserInfo = UserInfo.instance;

  build() {
    Column() {
      Scroll() {
        Column() {
          // 用户信息模块
          Row() {
            Image(this.userInfo.userAvatar)
              .width(56)
              .height(56)
              .borderRadius(28)
              .margin({ left: 12 })

            Text(this.userInfo.userName)
              .fontSize(18)
              .fontColor($r('sys.color.font_primary'))
              .fontWeight(FontWeight.Medium)
              .margin({ left: 12 })
          }
          .width('100%')
          .height(72)
          .backgroundColor($r('sys.color.comp_background_list_card'))
          .borderRadius(16)
          .onClick(async () => {
            if (this.userInfo.isLogin) {
              this.appPathStack.pushPathByName('UserInfoPage', undefined);
            } else {
              this.appPathStack.pushPathByName('QuickLoginPage', undefined);
            }
          });

          List() {
            ForEach(COMMON_SERVICE, (item: MinePageCommonService) => {
              ListItem() {
                MineItem({
                  commonService: item,
                  appPathStack: this.appPathStack
                })
              }
            }, (item: MinePageCommonService) => item.label)
          }
          .scrollBar(BarState.Off)

          ContactItem({
            commonService: {
              icon: 'app.media.contact',
              label: '联系客服',
            },
            appPathStack: this.appPathStack
          })
        }
        .width('100%')
      }
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .padding({
      top: 10,
      left: $r('sys.float.padding_level8'),
      right: $r('sys.float.padding_level8'),
    })
  }
}

@ComponentV2
export struct MineView {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();

  build() {
    NavDestination() {
      MineViewContent();
    }
    .title('我的')
    .backgroundColor($r('sys.color.background_secondary'))
  }
}