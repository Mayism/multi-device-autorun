import { TabItemModel } from '../types/Types';

@ObservedV2
export class MainVM {
  // 页签索引
  @Trace curIndex: number = 0;
  public controller: TabsController = new TabsController();
  public tabList: TabItemModel[] = [
    {
      label: $r('app.string.tab_home'),
      icon: $r('app.media.ic_tab0'),
      iconSelected: $r('app.media.ic_tab0_selected'),
    },
    {
      label: $r('app.string.tab_video'),
      icon: $r('app.media.ic_tab2'),
      iconSelected: $r('app.media.ic_tab2_selected'),
    },
    {
      label: $r('app.string.tab_mine'),
      icon: $r('app.media.ic_tab1'),
      iconSelected: $r('app.media.ic_tab1_selected'),
    },
  ];
  private static _instance: MainVM;

  public static get instance() {
    if (!MainVM._instance) {
      MainVM._instance = new MainVM();
    }
    return MainVM._instance;
  }
}