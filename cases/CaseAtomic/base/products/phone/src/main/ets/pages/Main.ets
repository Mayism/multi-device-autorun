import { Home } from 'business_home';
import { Mine } from 'business_mine';
import { VideoPageBuilder } from 'business_video';
import { CommonConstants } from 'lib_foundation';
import { VideoType } from 'lib_common';
import { MainVM } from '../viewmodels/MainVM';

@Builder
export function mainBuilder() {
  Main()
}

@ComponentV2
struct Main {
  vm: MainVM = MainVM.instance;

  build() {
    NavDestination() {
      Tabs({ index: $$this.vm.curIndex }) {
        TabContent() {
          Home()
        }.tabBar(this.tabBarBuilder(0))

        TabContent() {
          VideoPageBuilder(VideoType.CHOICE)
        }.tabBar(this.tabBarBuilder(1))

        TabContent() {
          Mine()
        }.tabBar(this.tabBarBuilder(2))
      }
      .clip(false)
      .barMode(BarMode.Fixed)
      .animationDuration(0)
      .barHeight(70)
      .scrollable(false)
      .height(CommonConstants.FULL_PERCENT)
      .width(CommonConstants.FULL_PERCENT)
      .barPosition(BarPosition.End)
      .barBackgroundColor($r('sys.color.comp_background_primary'))
    }
    .hideTitleBar(true)
  }

  @Builder
  tabBarBuilder(index: number) {
    Column({ space: 4 }) {
      if (this.vm.curIndex === index) {
        Image(this.vm.tabList[index].iconSelected)
          .height(20)
          .width(18)
          .objectFit(ImageFit.Contain)
      } else {
        Image(this.vm.tabList[index].icon)
          .fillColor($r('sys.color.icon_secondary'))
          .height(20)
          .width(18)
          .objectFit(ImageFit.Contain)
      }
      Text(this.vm.tabList[index].label)
        .fontSize($r('sys.float.Caption_M'))
        .fontColor(this.vm.curIndex === index ? $r('app.color.common_theme_color') :
          $r('sys.color.font_secondary'))
    }
    .justifyContent(FlexAlign.Start)
    .width(CommonConstants.FULL_PERCENT)
    .height(CommonConstants.FULL_PERCENT)
    .padding({ top: CommonConstants.SPACE_6 })
    .id(index === 0 ? 'ss_home_tabs' : '')
  }
}