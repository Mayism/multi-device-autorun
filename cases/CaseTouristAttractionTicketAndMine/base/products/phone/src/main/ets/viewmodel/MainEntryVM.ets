import { AppPrivacyUtils, Constant } from 'common';
import { TABS_INFO } from '../model/TabBarInfo';

@ObservedV2
export class MainEntryVM {
  @Trace privacyImpl: AppPrivacyUtils = AppPrivacyUtils.instance;
  @Trace windowBottomHeight: number = AppStorage.get('windowBottomHeight') as number || 28;

  private static _instance: MainEntryVM;

  public static get instance() {
    if (!MainEntryVM._instance) {
      MainEntryVM._instance = new MainEntryVM();
    }
    return MainEntryVM._instance;
  }

  // 是否纵向Tab
  @Computed
  get isTabVertical() {
    return false;
  }

  @Computed
  get barPosition() {
    if (this.isTabVertical) {
      return BarPosition.Start;
    }
    return BarPosition.End;
  }

  @Computed
  get tabWidth(): Length {
    if (this.isTabVertical) {
      return Constant.LEFT_TAB_BAR_WIDTH;
    }
    return Constant.FULL_PERCENT;
  }

  @Computed
  get tabBarHeight(): Length {
    if (this.isTabVertical) {
      return Constant.LEFT_TAB_BAR_ITEM_HEIGHT * TABS_INFO.length;
    }
    return Constant.BOTTOM_TAB_BAR_HEIGHT + this.windowBottomHeight;
  }

  @Computed
  get showDivider(): DividerStyle | null {
    if (!this.isTabVertical) {
      return null;
    }
    return {
      strokeWidth: '1px',
      color: $r('sys.color.comp_divider'),
      startMargin: 0,
      endMargin: 0,
    } as DividerStyle;
  }
}
