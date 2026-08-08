import { Constant } from 'common';
import { Hotline } from 'service_hotline';
import { TitleBar } from 'uicomponents';
import { hotlines } from '../model/HotlineInfo';

@Builder
export function HotlinesBuilder() {
  Hotlines();
}

@ComponentV2
export struct Hotlines {
  @Consumer('mainPathStack') mainPathStack: NavPathStack = new NavPathStack();

  build() {
    NavDestination() {
      Column({ space: 12 }) {
        TitleBar({
          isShowBack: true, title: '服务热线', clickEvent: () => {
            this.mainPathStack.pop();
          },
        });

        GridRow({ columns: 4, gutter: { x: 8 }, direction: GridRowDirection.Row }) {
          GridCol({
            span: 4,
            offset: 0,
          }) {
            Column({ space: 12 }) {
              Hotline({ hotlines: hotlines });
            }.id('hotline').padding({ left: 16, right: 16 });
          }
        }
      }.height(Constant.FULL_PERCENT).backgroundColor($r('sys.color.background_secondary'));
    }.hideTitleBar(true);
  }
}
