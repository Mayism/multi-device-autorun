import { agreeDialogBuilder, PopViewUtils, RouterMap, RouterModule, SafeUtil } from 'lib_foundation';

@ObservedV2
export class SafeVM {
  public privacyClick() {
    RouterModule.push({ url: RouterMap.PRIVACY_POLICY });
  }

  public agreeBtnClick() {
    SafeUtil.setAgreed();
  }

  public cancelBtnClick() {
    PopViewUtils.showPopView(wrapBuilder(agreeDialogBuilder), { alignment: DialogAlignment.Center })
  }
}
