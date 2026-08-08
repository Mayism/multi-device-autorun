import { BookHomeCard, BookInfo, Constants, FontModel, TCRouter } from 'common';
import { LazyDataVM } from 'swiper_card';
import { AppStorageV2 } from '@kit.ArkUI';

/**
 * 书横卡
 */
@ComponentV2
export struct BookViewCard {
  @Param categoryName: ResourceStr = '';
  @Param @Require books: LazyDataVM<BookInfo>
  @Local fontModel: FontModel = AppStorageV2.connect(FontModel, () => new FontModel())!;

  aboutToAppear(): void {
  }

  @Builder
  bookCategoryBar(category: ResourceStr) {
    Row() {
      Text(category)
        .fontColor($r('sys.color.font_primary'))
        .fontSize(this.fontModel.getFg(20))
        .fontWeight(FontWeight.Medium)
      Row() {
        Text($r('app.string.more'))
          .fontSize(this.fontModel.getFg(14))
          .fontColor($r('sys.color.font_secondary'))
        Image($r('app.media.arrow_right'))
          .height(20)
          .width(20)
      }
      .onClick(() => {
        TCRouter.push(Constants.BOOK_LIST_ROUTE, { category: this.categoryName, books: this.books.getAllData() })
      })
    }
    .width('100%')
    .height(30)
    .margin({ top: 12, bottom: 12 })
    .justifyContent(FlexAlign.SpaceBetween)
  }

  build() {
    Column() {
      this.bookCategoryBar(this.categoryName)
      Grid() {
        LazyForEach(this.books, (item: BookInfo) => {
          GridItem() {
            BookHomeCard({ info: item })
          }
          .id('guess_like_item')
        }, (item: BookInfo) => item.id + '_' + item.name)
      }
      .columnsTemplate('1fr '.repeat(3))
      .columnsGap(8)
      .rowsGap(8)
      .scrollBar(BarState.Off)
      .cachedCount(3)
      .id('guess_like_list')
    }
    .backgroundColor($r('sys.color.background_primary'))
    .width(Constants.FULL_SIZE)
    .padding({
      top: 25,
      left: 18,
      right: 18,
      bottom: 20
    })
  }
}
