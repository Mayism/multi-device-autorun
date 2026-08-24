import { readDataFromRawFile } from '@ohos_agcit/notes_utils';
import { MergeArrow } from '../../components/SettingComponents';

/**
 * 关于我们
 */
@Builder
export function PrivacySettingBuilder() {
  PrivacySetting();
}

@ComponentV2
export struct PrivacySetting {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();

  build() {
    NavDestination(){
      Column(){
        Scroll() {
          Column({ space: 12 }){
            MergeArrow({
              text1: '用户协议',
              text1Click: () => {
                let privacyUrl = readDataFromRawFile<string>(this.getUIContext(),'data.json', 'privacy_url');
                if (privacyUrl !== undefined) {
                  const params: Record<string, Object> = { 'protocolUrl':  privacyUrl};
                  this.appPathStack.pushPathByName('PrivacyAgreement', params);
                }
              },
              text2: '隐私政策',
              text2Click: () => {
                let privacyUrl = readDataFromRawFile<string>(this.getUIContext(),'data.json', 'privacy_url');
                if (privacyUrl !== undefined) {
                  const params: Record<string, Object> = { 'protocolUrl':  privacyUrl};
                  this.appPathStack.pushPathByName('PrivacyAgreement', params);
                }
              },
            })

            MergeArrow({
              text1: '第三方信息共享清单',
              text1Click: () => {
                let privacyUrl = readDataFromRawFile<string>(this.getUIContext(),'data.json', 'privacy_url');
                if (privacyUrl !== undefined) {
                  const params: Record<string, Object> = { 'protocolUrl':  privacyUrl};
                  this.appPathStack.pushPathByName('PrivacyAgreement', params);
                }
              },
              text2: '个人信息收集清单',
              text2Click: () => {
                let privacyUrl = readDataFromRawFile<string>(this.getUIContext(),'data.json', 'privacy_url');
                if (privacyUrl !== undefined) {
                  const params: Record<string, Object> = { 'protocolUrl':  privacyUrl};
                  this.appPathStack.pushPathByName('PrivacyAgreement', params);
                }
              },
            })
          }
          .width('100%')
        }
          .scrollBar(BarState.Off)
          .edgeEffect(EdgeEffect.Spring)
      }
      .height('100%')
      .padding({
        top: 10,
        left: $r('sys.float.padding_level8'),
        right: $r('sys.float.padding_level8'),
      })
    }
    .backgroundColor($r('sys.color.background_secondary'))
    .title('隐私设置')
  }
}