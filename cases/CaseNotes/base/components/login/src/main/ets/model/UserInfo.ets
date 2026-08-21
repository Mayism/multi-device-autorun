/**
 * 用户信息
 */
@ObservedV2
export class UserInfo {
  private static _instance: UserInfo;

  public static get instance() {
    if (!UserInfo._instance) {
      UserInfo._instance = new UserInfo();
    }
    return UserInfo._instance;
  }

  @Trace isLogin: boolean = false;
  @Trace userName: string = '点击登录';
  @Trace userAvatar: ResourceStr = $r('app.media.avatar');
  @Trace phone: string = 'a00000000000';

  logIn(){
    this.isLogin = true;
    this.userName = '华为用户';
  }

  logOut(){
    this.isLogin = false;
    this.userName = '点击登录';
    this.userAvatar = $r('app.media.avatar');
    this.phone = 'a00000000000';
  }
}