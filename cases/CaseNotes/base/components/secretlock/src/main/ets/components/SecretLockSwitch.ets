import { CustomContentDialog, PersistenceV2 } from '@kit.ArkUI';
import { SecretLock } from '../model/SecretLock';


@ComponentV2
export struct SecretLockSwitch {
  @Local secretLock: SecretLock = PersistenceV2.connect(SecretLock, () => new SecretLock())!!;
  @Param @Require appPathStack: NavPathStack;

  dialogController: CustomDialogController = new CustomDialogController({
    builder: CustomContentDialog({
      primaryTitle: '设置手势密码',
      contentBuilder: () => {
        this.myBuilder();
      },
      buttons: [
        {
          value: '取消',
          buttonStyle: ButtonStyleMode.TEXTUAL,
          action: () => {

          },
        },
        {
          value: '去设置',
          buttonStyle: ButtonStyleMode.TEXTUAL,
          role: ButtonRole.ERROR,
          action: () => {
            const params: Record<string, Object> = { 'fromEntrance': false, 'appPathStack': this.appPathStack}
            this.appPathStack.pushPathByName('DrawLock', params);
          },
        },
      ],
    }),
    autoCancel: false,
  });

  @Builder
  myBuilder() {
    Column() {
      Text('请先设置手势密码，以便能使用指纹手势密码解锁笔记');
    };
  }

  build() {
    Column({ space: 12 }) {
      Row() {
        Text('手势密码')
          .fontSize(16)
          .fontColor($r('sys.color.font_primary'))
        Blank();

        Toggle({
          type: ToggleType.Switch,
          isOn: this.secretLock.gesture,
        })
          .selectedColor($r('sys.color.comp_background_emphasize'))// 设置enable=false时，会有一层透明度覆盖原本颜色来阻断交互，
            // 使用.hitTestBehavior(this.isEnable? HitTestMode.Transparent: HitTestMode.None) 代替enable阻断交互
          .hitTestBehavior(this.secretLock.gesture ? HitTestMode.Transparent : HitTestMode.None)
          .onClick(() => {
            if (this.secretLock.gesture) {
              this.reset();
              PersistenceV2.save(SecretLock);
              return;
            }
            const params: Record<string, boolean | NavPathStack> = { 'fromEntrance': false, 'appPathStack': this.appPathStack}
            this.appPathStack.pushPathByName('DrawLock', params);
          });
      }
      .backgroundColor($r('sys.color.comp_background_list_card'))
      .borderRadius(16)
      .height(56)
      .width('100%')
      .padding({
        left: 12,
        right: 12,
      })
      .onClick(() => {
        if (this.secretLock.gesture) {
          this.reset();
          PersistenceV2.save(SecretLock);
          return;
        }
        const params: Record<string, boolean | NavPathStack> = { 'fromEntrance': false, 'appPathStack': this.appPathStack}
        this.appPathStack.pushPathByName('DrawLock', params);
      });

      Row() {
        Text('指纹解锁')
          .fontSize(16)
          .fontColor($r('sys.color.font_primary'))

        Blank();

        Toggle({
          type: ToggleType.Switch,
          isOn: this.secretLock.fingerprint,
        })
          .selectedColor($r('sys.color.comp_background_emphasize'))
          .hitTestBehavior(this.secretLock.fingerprint ? HitTestMode.Transparent : HitTestMode.None)
          .onClick(() => {
            if (!this.secretLock.gesture) {
              this.dialogController.open();
              return;
            }
            this.secretLock.fingerprint = !this.secretLock.fingerprint;
            PersistenceV2.save(SecretLock);
          });
      }
      .backgroundColor($r('sys.color.comp_background_list_card'))
      .borderRadius(16)
      .height(56)
      .width('100%')
      .padding({
        left: 12,
        right: 12,
      })
      .onClick(() => {
        if (!this.secretLock.gesture) {
          this.dialogController.open();
          return;
        }
        this.secretLock.fingerprint = !this.secretLock.fingerprint;
        PersistenceV2.save(SecretLock);
      });
    }
    .width('100%')
    .height('100%')
    .padding({
      top: 10
    });
  }

  reset() {
    this.secretLock.gesture = false;
    this.secretLock.password = [];
    this.secretLock.fingerprint = false;
  }
}