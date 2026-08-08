import { WidgetUtil } from 'business_home';
import { GlobalContextUtils } from 'lib_common';
import { RouterModule } from 'lib_foundation';
import { IndexVM } from '../viewmodels/IndexVM';

@Entry
@ComponentV2
struct Index {
  vm: IndexVM = new IndexVM();

  aboutToAppear(): void {
    // 拦截
    this.vm.checkSafeAgreed();
    // 初始化
    this.vm.init();
    // 视频模块依赖：缓存 UIContext，评论弹层等需要 px2vp 的地方依赖它
    GlobalContextUtils.setUIContext('phone', this.getUIContext());
    // 订阅卡片增删
    WidgetUtil.subscribeFormId(getContext());
  }

  build() {
    Navigation(RouterModule.stack) {
    }
    .hideNavBar(true)
    .hideTitleBar(true)
  }
}