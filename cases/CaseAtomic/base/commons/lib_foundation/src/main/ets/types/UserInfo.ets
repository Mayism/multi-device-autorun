export interface UserInfo {
  // 用户id
  id: number;

  // 用户头像
  avatar: string;

  // 用户昵称
  nickname: string;

  // 用户电话
  cellphone: string;

  // 用户code
  code: string;

  // 登录状态
  isLogin: boolean;
}

@ObservedV2
export class UserInfoModel implements UserInfo {
  @Trace id: number = 0;
  @Trace avatar: string = '';
  @Trace nickname: string = '';
  @Trace cellphone: string = '';
  @Trace code: string = '';
  @Trace isLogin: boolean = false;
}