import { AccountUtil, CommonConstants, CommonHeader, RouterModule, UserInfo, WindowUtil } from 'lib_foundation';
import { QuickLogin } from 'module_login';
import { promptAction } from '@kit.ArkUI';

@Builder
export function quickLoginPageBuilder() {
  QuickLoginPage();
}

@ComponentV2
export struct QuickLoginPage {
  build() {
    NavDestination() {
      CommonHeader({ title: '登录' })
      Column() {
        QuickLogin({
          icon: $r('app.media.app_icon'),
          loginBtnBgColor: '#CD0D2D',
          appName: 'xxx',
          // 登录回调方法
          onLoginWithHuaweiID: () => {
            this.loginSuccess();
            promptAction.showToast({ message: '登陆成功', duration: 2000 });
            RouterModule.pop();
          },
          // 隐私协议方法
          onPrivacyPolicy: () => {
            promptAction.showToast({ message: '隐私协议点击事件', duration: 2000 });
          },
          // 服务协议方法
          onServicePolicy: () => {
            promptAction.showToast({ message: '服务协议点击事件', duration: 2000 });
          },
          // 华为账号用户认证协议
          onHYAccountRouter: () => {
            promptAction.showToast({ message: '华为账号用户认证协议点击事件', duration: 2000 });
          },
        })
      }
      .layoutWeight(1)
    }
    .hideTitleBar(true)
    .backgroundColor($r('sys.color.background_secondary'))
    .padding({ bottom: WindowUtil.getAvoidArea().bottom })
  }

  loginSuccess() {
    // 模拟登录
    let data: UserInfo = {
      id: 0,
      avatar: '',
      nickname: '华为用户',
      cellphone: '130****0000',
      code: '',
      isLogin: true,
    };
    AccountUtil.updateUserInfo(data);
  }
}