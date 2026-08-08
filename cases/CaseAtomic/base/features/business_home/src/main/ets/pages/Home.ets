import { CardAttributeUpdater, CommonConstants } from 'lib_foundation';
import { HomeVM } from '../viewmodels/HomeVM';

@ComponentV2
export struct Home {
  vm: HomeVM = HomeVM.instance;
  cardOtherModifier: CardAttributeUpdater = new CardAttributeUpdater();

  aboutToAppear(): void {
    this.vm.init();
  }

  build() {
    Column() {
      Scroll(this.vm.scrollerController) {
        Column() {
          Blank().layoutWeight(1).width(CommonConstants.FULL_PERCENT)
        }
        .margin({ top: this.vm.topPadding })
        .backgroundColor($r('sys.color.background_primary'))
        .borderRadius({ topLeft: 16, topRight: 16 })
        .clip(true)
      }
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Fade)
      .width(CommonConstants.FULL_PERCENT)
      .height(CommonConstants.FULL_PERCENT)
      .onScrollFrameBegin((offset) => {
        this.vm.scroll();
        return { offsetRemain: offset };
      })
    }
  }
}
