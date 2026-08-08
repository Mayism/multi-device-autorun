import { PersistenceV2 } from '@kit.ArkUI';
import { RouterMap } from '../constants/RouterMap';
import { PopViewUtils } from './PopViewUtils';
import { RouterModule } from './RouterModule';

@ObservedV2
class SafeModel {
  @Trace agreed: boolean = false;
}

@ObservedV2
export class SafeUtil {
  private static _safeInfo: SafeModel = PersistenceV2.connect(SafeModel, 'safeInfo', () => new SafeModel())!;

  public static setAgreed() {
    PopViewUtils.closePopView()
    RouterModule.replace({ url: RouterMap.MAIN })
  }

  public static getAgreed() {
    return SafeUtil._safeInfo.agreed;
  }
}

