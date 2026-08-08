import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { NetworkUtils } from '../common/NetworkUtils';
import { WindowUtils } from '../common/WindowUtils';

const TAG = 'PhoneAbility';

export default class PhoneAbility extends UIAbility {
  public onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0xff00, TAG, 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(0xff00, TAG, 'Succeeded in loading the content.');
      // 视频模块依赖：填充 WindowModel（窗口避让/尺寸）并缓存 windowStage，供 SystemBarOperation 等使用
      WindowUtils.setWinConfig(windowStage);
      // 模拟器跳过网络监听注册（断网页面在网络监听就绪后才会生效）
      if (deviceInfo.productModel !== 'emulator') {
        NetworkUtils.initNetwork();
      }
    });
  }
}