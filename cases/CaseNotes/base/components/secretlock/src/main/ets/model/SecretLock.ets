/**
 * 密码锁-保密设置
 */
@ObservedV2
export class SecretLock {
  /**
   * 手势密码-是否开启
   */
  @Trace gesture: boolean = false;
  /**
   * 手势密码
   */
  @Trace password: Array<number> = [];
  /**
   * 指纹解锁-是否开启
   */
  @Trace fingerprint: boolean = false;
}