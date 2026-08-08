/**
 * 用户信息
 */
@ObservedV2
export class UserInfoModel {
  @Trace isLogin: boolean = false;
  @Trace authorId: string = '';
  @Trace authorNickName: string = '';
  @Trace authorIcon: string = '';
  @Trace authorDesc: string = '';
  @Trace authorPhone: string = '';
  @Trace authorIp: string = '';
  @Trace watchersCount: number = 0;
  @Trace followersCount: number = 0;
  @Trace watchers: string[] = [];
  @Trace followers: string[] = [];
  @Trace subscribe: string[] = [];
  @Trace likeNum: number = 0;
  @Trace loginChannel: string = '';
  @Trace isMembership: boolean = false;
}