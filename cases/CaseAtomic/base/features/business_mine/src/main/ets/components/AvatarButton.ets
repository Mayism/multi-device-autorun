import { FunctionalButton, functionalButtonComponentManager } from '@hms.core.atomicserviceComponent.atomicserviceUi';
import { AccountUtil, Logger } from 'lib_foundation';
import { MineVM } from '../viewmodels/MineVM';

const TAG = '[AvatarButton]';

@ComponentV2
export struct AvatarButton {
  vm: MineVM = MineVM.instance;

  build() {
    FunctionalButton({
      params: {
        openType: functionalButtonComponentManager.OpenType.CHOOSE_AVATAR,
        label: '',
        styleOption: {
          styleConfig: new functionalButtonComponentManager.ButtonConfig()
            .type(ButtonType.Normal)
            .backgroundImage(this.vm.userInfo.avatar === '' ? $r('app.media.default_avatar') :
            this.vm.userInfo.avatar)
            .backgroundImageSize(ImageSize.Cover)
            .backgroundColor(Color.Transparent)
            .width(40)
            .height(40)
            .borderRadius('50%'),
        },
      },
      controller: new functionalButtonComponentManager.FunctionalButtonController().onChooseAvatar((err, data) => {
        if (err) {
          Logger.error(TAG, err.code + '', err.message);
          return;
        }
        if (data.avatarUri) {
          AccountUtil.updateAvatar(data.avatarUri);
          Logger.info(TAG, 'succeeded in choosing avatar');
        } else {
          Logger.error(TAG, 'Failed: the uri is empty.');
        }
      }),
    })
  }
}