/**
 * 设置页面控制器
 */
@ObservedV2
export class SettingController {
  private static _instance: SettingController;

  public static get instance() {
    if (!SettingController._instance) {
      SettingController._instance = new SettingController();
    }
    return SettingController._instance;
  }

  // 通知开关
  @Trace noticeToggle: boolean = false;

  // 是否授权
  @Trace isNoticeGrant: boolean = false;
}