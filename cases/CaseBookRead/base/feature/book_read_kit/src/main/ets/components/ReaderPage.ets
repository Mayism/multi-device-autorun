import { AppStorageV2, CustomContentDialog } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { emitter, systemDateTime } from '@kit.BasicServicesKit';
import { Logger } from '@hw-agconnect/ui-base';
import { baseActionSheet, UserInfo } from 'base_common';
import { ReviewDataUtil } from '../utils/ReviewDataUtil';
import {
  BookApi,
  BookInfo,
  ColorModeClass,
  Constants,
  EpubUtils,
  ImmersiveListener,
  TCRouter,
  WindowUtils
} from 'common';
import { ReaderTopCard } from './ReaderTopCard';
import { BookCoverCard } from './BookCoverCard';

@ComponentV2
export struct ReaderPage {
  @Local userInfo: UserInfo | undefined
  @Local book: BookInfo | undefined = undefined
  @Local lockedStatus: boolean[] = []
  @Local curChapterId: number = 0
  private context: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
  private windowClass = this.context.windowStage.getMainWindowSync();
  @Local isLoading: boolean = true;
  @Local startTime: number = 0;
  @Local endTime: number = 0;
  @Local showController: boolean = false;
  @Local price: number = 10
  @Local isShowBuySheet: boolean = false
  @Local reminderTime: number = 0
  @Local timerId?: number
  @Local isNavigatingToReview: boolean = false;
  @Local isLastPage: boolean = false;
  @Local hasTriggeredReviewNavigation: boolean = false;
  @Local swiperIndex: number = 0
  @Local nightCurrentMode: ColorModeClass = AppStorageV2.connect(ColorModeClass, () => new ColorModeClass())!
  @Provider('nightMode') nightMode: boolean = AppStorage.get<boolean>('bookNightMode') ?? false;
  windowTopHeight: number = AppStorage.get('windowTopHeight') as number
  bottomRectHeight: number = AppStorage.get('bottomRectHeight') as number
  textClockController: TextClockController = new TextClockController();
  dialogController: CustomDialogController = new CustomDialogController({
    builder: CustomContentDialog({
      contentBuilder: () => {
        this.reminderDialogBuilder();
      },
    }),
    cancel: this.onAccept,
    alignment: DialogAlignment.Center,
    customStyle: false,
    cornerRadius: 32,
    width: 328,
    backgroundColor: Color.White,
  })

  aboutToAppear(): void {
    const p = TCRouter.getParams<BookInfo>(Constants.READ_KIT_ROUTER);
    if (p) {
      this.book = p;
      ReviewDataUtil.setCurrentBookInfo(this.book);
      ImmersiveListener.immersiveListening(this.book, '')
    }
  }

  aboutToDisappear(): void {
    ImmersiveListener.immersiveDisablingListening()
  }

  @Builder
  reminderDialogBuilder() {
    Column({ space: 24 }) {
      Image($r('app.media.rest_reminder'))
        .width(220)
        .height(220)
        .objectFit(ImageFit.Contain)
      Row({ space: 4 }) {
        Text('您已经阅读了')
          .fontSize(16)
        Text(this.reminderTime + '分钟')
          .fontSize(16)
          .fontColor('#E84026')
          .fontWeight(FontWeight.Bold)
        Text('休息一下吧~~')
          .fontSize(16)
      }

      Button('我知道了')
        .backgroundColor('#0D000000')
        .fontColor($r('sys.color.warning'))
        .width(Constants.FULL_SIZE)
        .onClick(() => {
          this.onAccept()
        })
    }
    .padding({
      left: 24,
      right: 24
    })
  }

  // 处理书币扣费和更新
  private updateBookCoinsAndSave(price: number): void {
    if (this.userInfo) {
      try {
        this.userInfo.bookCoins -= price;
        AppStorage.set('userInfo', this.userInfo);
        emitter.emit(Constants.COINS_CHANGE);
      } catch (e) {
        console.error('Failed to emitter emit coins change. Cause: ' + JSON.stringify(e));
      }
    }
  }

  @Builder
  buildBuyChapter(index: number) {
    Column({ space: 8 }) {
      Text(`价格：${this.price}书币`)
      Text(`余额：${this.userInfo!.bookCoins}书币`)
      Row() {
        Checkbox()
          .onChange((value) => {
            this.userInfo!.continuousBuy = value
          })
        Text('自动购买下一章')
      }

      Button('购买')
        .onClick(() => {
          if (this.price > this.userInfo!.bookCoins!) {
            this.getUIContext().getPromptAction().showToast({
              message: '余额不足',
              duration: 2000
            });
          } else {
            this.updateBookCoinsAndSave(this.price)
            this.lockedStatus[index] = false
            this.isShowBuySheet = false
            baseActionSheet.close('buyChapter')
          }
        })
        .width('100%')
    }
    .padding({ bottom: this.bottomRectHeight, left: 16, right: 16 })
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }

  async loadBook() {
    this.userInfo = AppStorage.get<UserInfo>('userInfo');
    this.startTime = systemDateTime.getTime(false)

    if (!this.book?.isDownload) {
      this.book!.localPath =
        await EpubUtils.loadEpubFileFromNetwork(this.book!, (this.getUIContext().getHostContext() as Context).cacheDir)
    }
    const hisRsp = await BookApi.getBooksShelfList('historyBooks', Constants.API_GET_BOOK_HISTORY_PATH, '');
    let books = hisRsp.books;
    let index = books.findIndex(book => book.id === this.book!.id)
    if (index !== -1) {
      books.splice(index, 1);
    }
    books.unshift(this.book!);
    AppStorage.set('historyBooks', books);
  }

  private async preprocess() {
    if (this.book?.isFree! === '2') {
      this.lockedStatus = AppStorageV2.connect(Array, 'lockedStatus', () => []) as boolean[]
      // mock付费章节
      if (this.lockedStatus.length === 0) {
        this.lockedStatus.push(false)
        this.lockedStatus.push(false)
        this.lockedStatus.push(false)
      }
    }
    this.hasTriggeredReviewNavigation = false;
    hilog.info(0x0000, 'testTag', '阅读器预处理完成，重置跳转标志位');
  }

  onWillHide(): void {
    try {
      // 删除缓存中的书籍
      EpubUtils.clearEpubFile(this.book!, (this.getUIContext().getHostContext() as Context).cacheDir, 'cache')
      this.endTime = systemDateTime.getTime(false)
      this.userInfo!.totalReading += Math.ceil((this.endTime - this.startTime) / 60000)
      AppStorage.set('userInfo', this.userInfo)

      this.notFullScreen()
      // 退出页面需要注销监听
      WindowUtils.onWindowSizeOff()
    } catch (error) {
      console.error('ReaderPage', ` readerComponentController error = ${JSON.stringify(error)}`)
    }
  }

  setFullScreen() {
    if (this.userInfo?.fullScreen) {
      try {
        this.windowClass.setWindowSystemBarEnable([]);
      } catch (e) {
        console.error('Failed to window setFullScreen. Cause: ' + JSON.stringify(e));
      }
    }
  }

  notFullScreen() {
    try {
      this.windowClass.setWindowSystemBarEnable(['status', 'navigation']);
    } catch (e) {
      console.error('Failed to window notFullScreen. Cause: ' + JSON.stringify(e));
    }
  }

  onAccept() {
    Logger.info('Accepted');
    this.dialogController.close()
    this.initTimer()
  }

  initTimer() {
    if (this.reminderTime > 0) {
      this.timerId = setTimeout((() => {
        this.dialogController.open()
      }), this.reminderTime * 60 * 1000);
      Logger.info('Timer is about to start' + this.timerId)
    }
  }

  clearTimer() {
    Logger.info('Timer has been cleared' + this.timerId)
    clearTimeout(this.timerId);
  }

  build() {
    NavDestination() {

      Swiper() {

        if (!AppStorage.has(this.book?.id)) {
          BookCoverCard({ book: this.book })
        }

        Stack() {
          if (this.showController) {
            Column() {
              ReaderTopCard({ book: this.book })

              Column() {
              }
              .layoutWeight(1)
              .width('100%')
              .hitTestBehavior(HitTestMode.Block)
              .onClick(() => {
                this.showController = false;
              })

            }
            // 透传点击事件
            .hitTestBehavior(HitTestMode.None)
          } else {
            Row() {
              if (!this.userInfo?.noTimeBattery) {
                TextClock({ timeZoneOffset: -8, controller: this.textClockController })
                  .format('hh:mm')
              }
            }
            .position({ bottom: this.bottomRectHeight })
            .padding({ left: 16, right: 16 })
            .width('100%')
            .justifyContent(this.userInfo?.noTimeBattery ? FlexAlign.End : FlexAlign.SpaceBetween)
          }

          Row() {
            Text('加载中...')
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
          .visibility(this.isLoading ? Visibility.Visible : Visibility.None)
        }
        .width('100%')
        .height('100%')
      }
      .onChange((index) => {
        this.swiperIndex = index
        if (index === 1) {
          this.setFullScreen()
        }
      })
      .indicator(false)
      .loop(false)
    }
    .hideTitleBar(true)
    .onWillAppear(async () => {
      // const p = TCRouter.getParams<BookInfo>(Constants.READ_KIT_ROUTER);
      // if (p) {
      //   this.book = p;
      //   ReviewDataUtil.setCurrentBookInfo(this.book);
      // }
      // this.onWindowsAppear()
    })
    .onWillShow(async () => {
      if (this.isNavigatingToReview) {
        this.isNavigatingToReview = false;
        this.hasTriggeredReviewNavigation = false;

        return;
      }
      await this.loadBook()
      await this.preprocess()
      this.initTimer()
    })
    .onWillHide(() => {
      this.onWillHide()
      this.clearTimer()
    })
  }
}