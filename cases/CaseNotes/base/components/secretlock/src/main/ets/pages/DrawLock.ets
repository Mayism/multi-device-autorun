import { LengthUnit, PersistenceV2 } from '@kit.ArkUI';
import { userAuth } from '@kit.UserAuthenticationKit';
import { SecretLock } from '../model/SecretLock';
import { AuthUtil } from '../util/AuthUtil';

@Builder
export function DrawLockBuilder() {
  DrawLock();
}

@ComponentV2
struct DrawLock {
  @Local secretLock: SecretLock = PersistenceV2.connect(SecretLock, () => new SecretLock())!!;
  @Local passwords: number[] = this.secretLock.password;
  // 主页上方提示信息
  // PatternLock组件控制器，可用于控制组件状态重置
  private patternLockController: PatternLockController = new PatternLockController();
  @Local fromEntrance: boolean = false;
  @Local message: ResourceStr = '';
  @Local appPathStack: NavPathStack = new NavPathStack();

  build() {
    NavDestination() {
      Column() {
        Column() {
          Text(this.message)
            .textAlign(TextAlign.Center)
            .fontSize(16);
        }
        .justifyContent(FlexAlign.Center)
        .height('30%')
        .width('100%');

        Column() {
          PatternLock(this.patternLockController)
            .border({
              radius: 10,
            })// 设置组件的宽度和高度（宽高相同）
            .sideLength(300)// 设置宫格中圆点的半径
            .circleRadius('12vp')// 设置连线的宽度
            .pathStrokeWidth(14)// 设置连线的颜色
            .pathColor($r('sys.color.icon_fourth'))// 设置宫格圆点在“激活”状态的填充颜色，“激活”状态为手指经过圆点但还未选中的状态
            .activeColor($r('sys.color.comp_foreground_primary'))// 设置宫格圆点在“选中“状态的填充颜色
            .selectedColor($r('sys.color.comp_foreground_primary'))// 设置在完成密码输入后再次在组件区域按下时是否重置组件状态，默认为true
            .autoReset(true)// 设置宫格圆点在“激活”状态的背景圆环样式
            .activateCircleStyle({
              color: '#90EE90',
              radius: {
                value: 18,
                unit: LengthUnit.VP,
              },
              enableWaveEffect: true,
            })
            .onPatternComplete((input: number[]) => {
              // 输入密码长度小于5位时，提示错误
              if (!input || input.length < 5) {
                this.message = '图形密码长度需不少于5位，请确认！';
                // 设置图案密码错误
                this.patternLockController?.setChallengeResult(PatternLockChallengeResult.WRONG);
                setTimeout(() => {
                  this.patternLockController?.reset();
                }, 1000);
                return;
              }

              // 判断密码长度是否大于0，当前处于第二次输入密码状态
              if (this.passwords.length > 0) {
                if (this.passwords.toString() === input.toString()) {
                  this.secretLock.gesture = true;
                  this.secretLock.password = this.passwords;
                  PersistenceV2.save(SecretLock);
                  this.message = '图形密码设置成功,   请使用图形密码解锁';
                  this.patternLockController?.setChallengeResult(PatternLockChallengeResult.CORRECT);
                  this.appPathStack.pop();
                } else {
                  this.message = this.fromEntrance ? '密码输入错误，请重试！' : '两次图形密码设置不一致，请确认！';
                  this.patternLockController?.setChallengeResult(PatternLockChallengeResult.WRONG);
                  setTimeout(() => {
                    this.patternLockController?.reset();
                  }, 1000);
                }
              } else {
                this.passwords = input;
                this.message = '请再次设置图形密码！';
                setTimeout(() => {
                  this.patternLockController?.reset();
                }, 1000);
              }
            });
        }
        .justifyContent(FlexAlign.End)
        .width('100%')
        .height('50%');
      }
      .height('100%')
      .width('100%');
    }
    .onReady((cxt: NavDestinationContext) => {
      let param = cxt.pathInfo.param as Record<string, Object>;
      this.appPathStack = param.appPathStack as NavPathStack;
      this.fromEntrance = param.fromEntrance as boolean;
      this.message = this.fromEntrance ? '密码保护已开启，请先解锁密码' : '请绘制图形密码';
      let status = AuthUtil.getAvailableStatus(userAuth.UserAuthType.FINGERPRINT, userAuth.AuthTrustLevel.ATL2) &&
      this.secretLock.fingerprint;
      if (status) {
        AuthUtil.onStartEasy(this.getUIContext(),true, (result: userAuth.UserAuthResult) => {
          if (result.result === 12500000) {
            this.appPathStack.pop();
          }
        },
          userAuth.UserAuthType.FINGERPRINT,
        );
      }
    })
    .title('隐私密码')
    .hideTitleBar(this.fromEntrance);
  }
}