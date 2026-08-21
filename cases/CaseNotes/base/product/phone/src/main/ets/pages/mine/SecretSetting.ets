import { SecretLockSwitch } from 'secretlock';

@Builder
export function SecretSettingBuilder() {
  SecretSetting();
}

@ComponentV2
export struct SecretSetting {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();

  build() {
    NavDestination() {
      SecretLockSwitch({
        appPathStack: this.appPathStack
      })
        .padding({
          left: $r('sys.float.padding_level8'),
          right: $r('sys.float.padding_level8'),
        })

    }
    .title('保密设置')
    .backgroundColor($r('sys.color.background_secondary'))
  }
}
