import { RouterMap, RouterModule, SafeUtil, WindowUtil } from 'lib_foundation';

@ObservedV2
export class IndexVM {
  private static _instance: IndexVM;

  public static get instance() {
    if (!IndexVM._instance) {
      IndexVM._instance = new IndexVM();
    }
    return IndexVM._instance;
  }

  public async init() {
    WindowUtil.initWindowUtil().then(() => {
      WindowUtil.setFullWindow();
    });
  }

  public checkSafeAgreed() {
    if (SafeUtil.getAgreed()) {
      RouterModule.push({ url: RouterMap.MAIN })
      return;
    }
    RouterModule.push({ url: RouterMap.SAFE })
  }
}