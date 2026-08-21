import { AccommodationInfo, CateringInfo, Constant, https } from 'module_base';
import { ListItemCard } from '../component/ListItemCard';
import { CustomTitle } from '../component/TitleBar';
import { CateringTabBarType } from '../model/Index';
import { CateringPageVM } from '../viewmodel/CateringPageVM';

@Builder
export function CateringAndAccommodationBuilder() {
  CateringAndAccommodation();
}

@ComponentV2
export struct CateringAndAccommodation {
  vm: CateringPageVM = CateringPageVM.instance;
  @Local index: number = 0;
  @Consumer('mainPathStack') mainPathStack: NavPathStack = new NavPathStack();
  tabsController: TabsController = new TabsController();

  aboutToAppear(): void {
    this.vm.getCateringInfo(CateringTabBarType.CATERING);
    this.vm.getCateringInfo(CateringTabBarType.ACCOMMODATION);
  }

  @Builder
  cateringTabBar() {
    Row() {
      Text('餐饮')
        .fontColor(
          this.index === CateringTabBarType.CATERING ? $r('sys.color.font_primary') : $r('sys.color.font_secondary'))
        .fontWeight(FontWeight.Medium)
        .fontSize($r('sys.float.Body_M'))
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .height(36)
        .padding({
          top: 6,
          bottom: 6,
          left: 12,
          right: 12,
        })
        .backgroundColor(
          this.index === CateringTabBarType.CATERING ? $r('sys.color.comp_background_primary_contrary_secondary') :
            '#00000000')
        .borderRadius(18)
        .shadow(this.index === CateringTabBarType.CATERING ? {
          radius: 3,
          offsetX: 0,
          offsetY: 0,
          color: '#33000000',
          fill: false,
        } : { radius: 0 })
        .onClick(() => {
          this.tabsController.changeIndex(CateringTabBarType.CATERING);
        });
      Text('住宿')
        .fontColor(
          this.index === CateringTabBarType.ACCOMMODATION ? $r('sys.color.font_primary') :
            $r('sys.color.font_secondary'))
        .fontWeight(FontWeight.Medium)
        .fontSize($r('sys.float.Body_M'))
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .height(36)
        .padding({
          top: 6,
          bottom: 6,
          left: 12,
          right: 12,
        })
        .backgroundColor(
          this.index === CateringTabBarType.ACCOMMODATION ? $r('sys.color.comp_background_primary_contrary_secondary') :
            '#00000000')
        .borderRadius(18)
        .shadow(this.index === CateringTabBarType.ACCOMMODATION ? {
          radius: 3,
          offsetX: 0,
          offsetY: 0,
          color: '#33000000',
          fill: false,
        } : { radius: 0 })
        .onClick(() => {
          this.tabsController.changeIndex(CateringTabBarType.ACCOMMODATION);
        });
    }
    .width(Constant.FULL_PERCENT)
    .constraintSize({ maxWidth: Constant.MAX_WIDTH })
    .padding(2)
    .backgroundColor($r('sys.color.comp_background_tertiary'))
    .borderRadius(20);
  }

  @Builder
  cateringList() {
    List({ space: 12 }) {
      LazyForEach(this.vm.cateringList, (item: CateringInfo) => {
        ListItem() {
          ListItemCard({
            type: CateringTabBarType.CATERING, data: item, routeToDetailPage: () => {
              https.getCateringDetail(item.siteId).then((res) => {
                item.banners = res.data.banner;
                item.startPrice = res.data.startPrice;
                item.detailImages = res.data.images;
                item.detail = res.data.detail;
                item.openHours = res.data.openHour;
                this.mainPathStack.pushPathByName('CateringDetail', item);
              });
            },
          });
        };
      }, (item: CateringInfo) => item.siteId);
    }
    .cachedCount(8)
    .lanes(1, 16)
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
    .layoutWeight(1)
    .contentStartOffset(16)
    .contentEndOffset(16);
  }

  @Builder
  accommodationList() {
    List({ space: 12 }) {
      LazyForEach(this.vm.accommodationList, (item: AccommodationInfo) => {
        ListItem() {
          ListItemCard({
            type: CateringTabBarType.ACCOMMODATION, data: item, routeToDetailPage: () => {
              https.getAccommodationDetail(item.siteId).then((res) => {
                item.banners = res.data.banner;
                item.detailImages = res.data.images;
                item.detail = res.data.detail;
                item.labels = res.data.label;
                this.mainPathStack.pushPathByName('AccommodationDetail', item);
              });
            },
          });
        };
      }, (item: AccommodationInfo) => item.siteId);
    }
    .cachedCount(8)
    .lanes(1, 16)
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
    .layoutWeight(1)
    .contentStartOffset(16)
    .contentEndOffset(16);
  }

  build() {
    NavDestination() {
      GridRow({ columns: 4, gutter: { x: 8 }, direction: GridRowDirection.Row }) {
        GridCol({
          span: 4,
        }) {
          Column() {
            CustomTitle({
              isShowBack: true,
              title: '餐饮住宿',
              clickEvent: () => {
                this.mainPathStack.pop();
              },
            });
            Column() {
              this.cateringTabBar();
              Tabs({ index: this.index, controller: this.tabsController }) {
                TabContent() {
                  this.cateringList();
                }
                TabContent() {
                  this.accommodationList();
                }
              }
              .barHeight(0)
              .scrollable(true)
              .onAnimationStart((index: number, targetIndex: number) => {
                this.index = targetIndex;
              })
              .layoutWeight(1)
            }.width(Constant.FULL_PERCENT).padding({ left: 16, right: 16 }).layoutWeight(1);
          };
        };
      };
    }.hideTitleBar(true).backgroundColor($r('sys.color.background_secondary'));
  }
}
