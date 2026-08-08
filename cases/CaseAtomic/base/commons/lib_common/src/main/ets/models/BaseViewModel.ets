import { AppStorageV2, PersistenceV2 } from '@kit.ArkUI';
import { TabModel } from './TabModel';
import { UserInfoModel } from './UserInfoModel';
import { WindowModel } from './WindowModel';
import { SettingModel } from './SettingModel';
import { NavRouteModel } from './NavRouteModel';
import { WindowStageModel } from './WindowStageModel';
import { BreakpointModel } from './BreakpointModel';
import { NetworkModel } from './NetworkModel';
import { VideoExtraInfoModel } from './VideoExtraInfoModel';
import { DisplayModel } from './DisplayModel';
import { ContextUtils, GlobalContextUtils } from '../utils/ContextUtils';

/**
 * 所有ViewModel的基类，支持UI动态观测
 */
@ObservedV2
export abstract class BaseViewModel {
  @Trace windowModel: WindowModel = AppStorageV2.connect(WindowModel, () => new WindowModel())!;
  @Trace userInfoModel: UserInfoModel = PersistenceV2.connect(UserInfoModel, () => new UserInfoModel())!;
  @Trace tabModel: TabModel = AppStorageV2.connect(TabModel, () => new TabModel())!;
  @Trace navRouteModel: NavRouteModel = AppStorageV2.connect(NavRouteModel, () => new NavRouteModel())!;
  @Trace settingInfo: SettingModel = PersistenceV2.connect(SettingModel, () => new SettingModel())!;
  @Trace windowStageModel: WindowStageModel = AppStorageV2.connect(WindowStageModel, () => new WindowStageModel())!;
  @Trace breakPointModel: BreakpointModel = AppStorageV2.connect(BreakpointModel, () => new BreakpointModel())!;
  @Trace networkModel: NetworkModel = AppStorageV2.connect(NetworkModel, () => NetworkModel.getInstance())!;
  @Trace videoExtraInfoModel: VideoExtraInfoModel =
    AppStorageV2.connect(VideoExtraInfoModel, () => VideoExtraInfoModel.getInstance())!;
  @Trace displayModel: DisplayModel = AppStorageV2.connect(DisplayModel, () => new DisplayModel())!;
  @Trace contextModel: ContextUtils = GlobalContextUtils;
}