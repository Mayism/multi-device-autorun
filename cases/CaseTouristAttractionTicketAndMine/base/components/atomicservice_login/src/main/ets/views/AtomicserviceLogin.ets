import { Constants } from '../common/Constant';
import { CancelAuthState, UserInfo } from '../model/UserInfo';
import { AccountUtils } from '../utils/AccountUtils';
import { ApiController } from '../utils/Utils';


@ComponentV2
export struct AtomicserviceLogin {
  @Require @Param userInfo: UserInfo;
  @Param initValue: ResourceStr = '华为用户';
  @Param controller: ApiController = new ApiController();
  @Event onCancelAuthorization: (state: CancelAuthState) => void = () => {
  };
  @Event unBindPhone: () => Promise<void> = () => new Promise(() => {
  });
  @Event linkToEdit: () => void = () => {
  };

  aboutToAppear(): void {
    this.controller.unlink = (unBindPhone: () => Promise<void>) => {
      this.getUIContext().showAlertDialog({
        title: '账号解除关联', message: '请确认是否解除账号关联？', buttons: [{
          value: '取消', action: () => {
          },
        }, {
          value: '确认', action: () => {
            AccountUtils.cancelRelative(this.onCancelAuthorization);
            unBindPhone();
          },
        }],
      });
    };
  }

  build() {
    Row() {
      Row() {
        Image(this.userInfo.avatar || $r('app.media.avatar_grey'))
          .width($r('app.float.mine_avatar_width'))
          .height($r('app.float.mine_avatar_height'))
          .borderRadius($r('sys.float.corner_radius_level10'))
          .margin({ right: Constants.PADDING_L })
          .objectFit(ImageFit.Fill);
        Column({ space: Constants.SPACE_XS }) {
          Text(this.userInfo.nickname || this.initValue)
            .fontSize($r('sys.float.Subtitle_L'))
            .fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.font_primary'))
            .height($r('app.float.mine_title_height'));
        }.alignItems(HorizontalAlign.Start);
      }.layoutWeight(1).onClick(() => {
        this.linkToEdit();
      });

      Button() {
        Row({ space: Constants.SPACE_XS }) {
          SymbolGlyph($r('sys.symbol.link_slash'))
            .fontColor([$r('sys.color.font_on_primary')])
            .fontSize($r('app.float.mine_link_width'));
          Text('取消关联')
            .fontColor($r('sys.color.font_on_primary'))
            .fontSize($r('sys.float.Body_M'))
            .fontWeight(FontWeight.Medium);
        };
      }
      .height(28)
      .controlSize(ControlSize.SMALL)
      .backgroundColor($r('sys.color.multi_color_04'))
      .padding({
        top: Constants.PADDING_XXS,
        bottom: Constants.PADDING_XXS,
        right: Constants.PADDING_S,
        left: Constants.PADDING_S,
      })
      .onClick(() => {
        this.controller.unlink(this.unBindPhone);
      });
    }
    .width(Constants.FULL_PERCENT)
    .padding(Constants.PADDING_M)
    .alignItems(VerticalAlign.Bottom)
    .justifyContent(FlexAlign.SpaceBetween);
  }
}
