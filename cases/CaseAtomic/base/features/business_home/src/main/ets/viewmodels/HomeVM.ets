import { AppStorageMap, LocationInfo, WindowUtil } from 'lib_foundation';
import { WidgetUtil } from '../utils/WidgetUtil';

@ObservedV2
export class HomeVM {
  @Trace rate: number = 0;
  @Trace location: LocationInfo = { name: '北京', code: '110100' };
  private static _instance: HomeVM;
  scrollerController: Scroller = new Scroller();
  swiperController: SwiperController = new SwiperController();
  topPadding: number = 536;

  @Monitor('location')
  private _change() {
    WidgetUtil.setLocation(this.location, getContext());
  }

  public static get instance() {
    if (!HomeVM._instance) {
      HomeVM._instance = new HomeVM();
    }
    return HomeVM._instance;
  }

  public async init() {
    // const res = await CityManager.applyLocationPermission();
    // this.location = { name: res.name, code: res.code };
  }

  public scroll() {
    const temp =
      this.scrollerController.currentOffset().yOffset / (this.topPadding - WindowUtil.getAvoidArea().top - 56);
    if (temp >= 1) {
      this.rate = 1;
    } else {
      this.rate = temp;
    }

    if (this.rate > 0.5) {
      this.swiperController.changeIndex(1, true);
    } else {
      this.swiperController.changeIndex(0, true);
    }
  }

}