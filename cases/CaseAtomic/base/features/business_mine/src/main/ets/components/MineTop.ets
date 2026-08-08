import { BaseTextStyleModifier, CommonConstants, RouterMap, RouterModule } from 'lib_foundation';
import { MineVM } from '../viewmodels/MineVM';

@ComponentV2
export struct MineTop {
  vm: MineVM = MineVM.instance;

  build() {
    Row() {
      Image(this.vm.userInfo.isLogin && this.vm.userInfo.avatar ? this.vm.userInfo.avatar :
        $r('app.media.default_avatar'))
        .borderRadius(CommonConstants.HALF_PERCENT)
        .width(48)
        .aspectRatio(1)
        .clip(true)

      Text(!this.vm.userInfo.isLogin ? '点击登录' :
        this.vm.userInfo.nickname === '' ? '华为用户' : this.vm.userInfo.nickname)
        .attributeModifier(new BaseTextStyleModifier('font_primary/Subtitle_L/Medium'))
        .layoutWeight(1)
        .textAlign(TextAlign.Start)
        .margin({ left: CommonConstants.SPACE_16, right: CommonConstants.SPACE_16 })

      Image($r('app.media.right_arrow'))
        .width(7)
        .margin({ right: CommonConstants.SPACE_3 })
        .fillColor($r('sys.color.icon_secondary'))
    }
    .width('100%')
    .backgroundColor($r('sys.color.comp_background_primary'))
    .borderRadius(16)
    .padding(12)
    .onClick(() => {
      RouterModule.push({ url: this.vm.userInfo.isLogin ? RouterMap.PROFILE_EDIT : RouterMap.QUICK_LOGIN });
    })
  }
}