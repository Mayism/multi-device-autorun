import { uiObserver } from '@kit.ArkUI';
import { RouterMap } from '../constants/RouterMap';

/**
 * 无感监听
 */
@ObservedV2
export class NavRouteModel {
  // 路由变化监听事件
  @Trace navDestinationUpdateListeners: Map<string, (info: uiObserver.NavDestinationInfo) => void> = new Map();
  // 跳转页面时，需要暂停视频播放的页面
  @Trace videoPauseByRoutePage: ResourceStr[] = [
    RouterMap.NEWS_SEARCH,
    RouterMap.PROFILE_HOME,
  ]
}
