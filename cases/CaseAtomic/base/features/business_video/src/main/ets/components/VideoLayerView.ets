import { AppStorageV2, PersistenceV2 } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  BreakpointModel,
  CommonConstants,
  Logger,
  SettingModel,
  TabBarType,
  TabModel,
  TimeUtils,
  UserInfoModel,
  WindowModel,
} from 'lib_common';
import { AVPlayerController, PlayerLayoutSize, SwipePlayerController, VideoProgressBar } from 'module_swipeplayer';

const TAG = '[VideoLayerView]'

@ComponentV2
export struct VideoLayerView {
  // 视频数据
  @Param @Require videoData: ESObject;
  // 播放会话
  @Param @Require avPlayerController: AVPlayerController;
  // 滑动播放控制器
  @Param @Require swipePlayerController: SwipePlayerController
  // 评论页面出现时，改变播放页面的尺寸
  @Param @Require playerLayoutSize: PlayerLayoutSize
  @Local isSliderMoving: boolean = false;
  windowModel: WindowModel = AppStorageV2.connect(WindowModel, () => new WindowModel())!;
  tabModel: TabModel = AppStorageV2.connect(TabModel, () => new TabModel())!;
  settingInfo: SettingModel = PersistenceV2.connect(SettingModel, () => new SettingModel())!;
  userInfoModel: UserInfoModel = PersistenceV2.connect(UserInfoModel, () => new UserInfoModel())!;
  breakPointModel: BreakpointModel = AppStorageV2.connect(BreakpointModel, () => new BreakpointModel())!;

  // 播放、暂停切换
  switchPlayOrPause() {
    let avPlayer = this.swipePlayerController.getAVPlayer()
    let state = avPlayer?.state
    if (state === 'playing') {
      avPlayer?.pause().catch((e: BusinessError) => {
        Logger.error(TAG, 'pause fail, error: ' + JSON.stringify(e));
      });
      // 当前是视频tab
      if (this.tabModel.selectedIndex === TabBarType.VIDEO) {
        this.tabModel.showTabBar = true
        Logger.debug(TAG, 'tab bar is visible: ' + this.tabModel.showTabBar)
      }
    } else {
      avPlayer?.play().catch((e: BusinessError) => {
        Logger.error(TAG, 'play fail, error: ' + JSON.stringify(e));
      });
      // 当前是视频tab
      if (this.tabModel.selectedIndex === TabBarType.VIDEO) {
        this.tabModel.showTabBar = false
        Logger.debug(TAG, 'tab bar is visible: ' + this.tabModel.showTabBar)
      }
    }
  }

  build() {
    RelativeContainer() {
      // 底部信息
      Stack({ alignContent: Alignment.Bottom }) {
        // 视频信息
        this.videoInfoView()

        Column({ space: CommonConstants.SPACE_M }) {
          // 视频的进度控制器
          VideoProgressBar({
            avPlayerController: this.avPlayerController,
            onSlideChange: (flag) => {
              this.isSliderMoving = flag;
              this.playerLayoutSize.updateSlideMovingFlag(flag)
            },
          })
        }
      }
      .width('100%')
      .alignRules({
        bottom: { anchor: '__container__', align: VerticalAlign.Bottom },
        left: { anchor: '__container__', align: HorizontalAlign.Start },
      })
    }
    .id('videoLayerView')
    .width(CommonConstants.FULL_PERCENT)
    .height(CommonConstants.FULL_PERCENT)
    .onClick(() => {
      this.switchPlayOrPause()
    })
  }

  @Builder
  videoInfoView() {
    Column({ space: 4 }) {
      Text('@' + this.videoData.author?.authorNickName)
        .fontSize(14)
        .fontColor(Color.White)
        .fontWeight(500)
      Text(this.videoData.title)
        .fontSize(14)
        .fontColor(Color.White)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      Text(TimeUtils.formatDate(this.videoData.createTime))
        .fontColor('#99ffffff')
        .fontSize(12)
    }
    .width(CommonConstants.FULL_PERCENT)
    .alignItems(HorizontalAlign.Start)
    .padding({
      left: this.breakPointModel.pagePadding,
      right: this.breakPointModel.pagePadding,
    })
    .offset({ bottom: 84 })
    .visibility(this.isSliderMoving ? Visibility.Hidden : Visibility.Visible)
    .accessibilityGroup(true)
    .accessibilityLevel('yes')
  }
}

@Builder
export function VideoLayerViewBuilder(
  videoData: ESObject,
  avPlayerController: AVPlayerController,
  swipePlayerController: SwipePlayerController,
  playerLayoutSize: PlayerLayoutSize,
) {
  VideoLayerView({
    videoData,
    avPlayerController,
    swipePlayerController,
    playerLayoutSize,
  })
}