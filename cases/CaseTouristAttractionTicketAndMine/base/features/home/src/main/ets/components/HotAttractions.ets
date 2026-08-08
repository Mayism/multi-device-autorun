import { Constant } from 'common';
import { AttractionInfo } from 'types';
import { HomePageVM } from '../viewmodel/HomePageVM';

@Builder
export function HotAttractionsBuilder() {
  HotAttractions();
}

@ComponentV2
struct HotAttractions {
  vm: HomePageVM = HomePageVM.instance;
  @Consumer('mainPathStack') mainPathStack: NavPathStack = new NavPathStack();

  build() {
    Column() {
      Grid() {
        LazyForEach(this.vm.hotAttractionList, (item: AttractionInfo) => {
          GridItem() {
            Stack() {
              Image(item.banner)
                .width('100%')
                .aspectRatio(4/3)
                .objectFit(ImageFit.Cover)
                .borderRadius(8)
                .mask(new ProgressMask(0, 1, $r('sys.color.mask_tertiary')));
              Text(item.name)
                .fontColor($r('sys.color.font_on_primary'))
                .fontWeight(FontWeight.Medium)
                .fontSize($r('sys.float.Body_L'));
            }.width('100%');
          }.onClick(() => {
            this.mainPathStack.pushPathByName('AttractionDetail', item.attractionId);
          });
        });
      }
      .columnsTemplate('1fr '.repeat(3))
      .columnsGap(8)
      .scrollBar(BarState.Off)
      .width(Constant.FULL_PERCENT)
      .align(Alignment.Start)
      .edgeEffect(EdgeEffect.Spring);
    }.backgroundColor($r('sys.color.background_secondary'));
  }
}
