import {
  MinorsMode,
  MinorsProtectionUtils,
  TabInfo
} from 'common';
import { UserInfo, fp2pxUtil } from 'base_common';
import { IndexData } from '../model/MainTab';
import { AppStorageV2 } from '@kit.ArkUI';

@ComponentV2
export struct BookHomePage {
  @Provider('isDeleteShelf') isDeleteShelf: boolean = false;
  @Provider('currentIndexTab') currentIndexTab: number = 0;
  @Provider('tabController') tabsController: TabsController = new TabsController();
  @Provider('isHistory') isHistory: boolean = false
  @Provider('userInfo') userInfo: UserInfo | undefined = undefined;
  @Local minorsMode: MinorsMode =
    AppStorageV2.connect(MinorsMode, 'isMinorsMode', () => new MinorsMode(MinorsProtectionUtils.getMinorsMode()))!

  aboutToAppear(): void {
    MinorsProtectionUtils.createSubscriber();
  }

  @Builder
  tabBuilder(title: string, index: number, selectedImg: Resource, normalImg: Resource) {
    Column() {
      SymbolGlyph(selectedImg)
        .fontSize(fp2pxUtil(24))
        .fontColor(this.currentIndexTab === index ? [$r('app.color.font_overdue')] :
          [$r('sys.color.icon_secondary')])
      Text(title)
        .margin({ top: 4 })
        .fontSize(fp2pxUtil(10))
        .fontColor(this.currentIndexTab === index ? $r('app.color.font_overdue') : $r('app.color.tab_color_default'))
    }
    .justifyContent(FlexAlign.Center)
    .width('100%')
    .id('home_tabbar')
    .onClick(() => {
      this.currentIndexTab = index;
      this.tabsController.changeIndex(this.currentIndexTab);
    })

  }

  build() {
    NavDestination() {
      Tabs({
        barPosition: BarPosition.End,
        index: this.currentIndexTab,
        controller: this.tabsController
      }) {
        ForEach(this.minorsMode.isMinorsMode ? IndexData.MINOR_TAB : IndexData.MAIN_TAB, (item: TabInfo) => {
          TabContent() {
            item.component?.builder();
          }
          .tabBar(this.tabBuilder(item.label, item.index, item.activeIcon, item.defaultIcon))
        }, (item: TabInfo) => item.index.toString()+item.label)
      }
      .clip(false)
      .height('100%')
      .backgroundColor($r('sys.color.background_secondary'))
      .padding({ bottom: 18 })
      .animationDuration(0)
      .scrollable(false)
      .barMode(BarMode.Fixed)
      .barWidth('100%')
      .barHeight(this.isDeleteShelf ? 0 : 'auto')
      .onAnimationStart((targetIndex: number) => {
        this.currentIndexTab = targetIndex;
      })
    }
    .onWillShow(() => {
      if (AppStorage.has('userInfo')) {
        this.userInfo = AppStorage.get('userInfo') as UserInfo;
      }
    })
    .hideTitleBar(true)
  }
}