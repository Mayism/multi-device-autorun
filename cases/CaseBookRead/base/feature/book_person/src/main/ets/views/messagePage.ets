import { TCRouter } from 'common'
import { PushKit } from 'custom_push'


@ComponentV2
export struct messagePage {
  build() {
    NavDestination() {
      PushKit({
        backPop: () => {
          TCRouter.pop()
        }
      })
    }
    .hideTitleBar(true)
    .hideBackButton(true)
  }
}