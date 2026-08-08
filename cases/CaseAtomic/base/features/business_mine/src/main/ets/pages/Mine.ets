import { CommonConstants, CommonHeader } from 'lib_foundation';
import { MineTop } from '../components/MineTop';
import { MineBot } from '../components/MineBot';

@ComponentV2
export struct Mine {
  build() {
    Column({ space: CommonConstants.SPACE_8 }) {
      /** 标题栏 **/
      CommonHeader({ title: '我的', showBackButton: false })

      Scroll() {
        Column({ space: CommonConstants.SPACE_12 }) {
          MineTop()


          MineBot()

          Blank().layoutWeight(1)
        }
      }
      .padding({ left: CommonConstants.SPACE_16, right: CommonConstants.SPACE_16 })
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
      .layoutWeight(1)
    }
    .backgroundColor($r('sys.color.background_secondary'))
  }
}
