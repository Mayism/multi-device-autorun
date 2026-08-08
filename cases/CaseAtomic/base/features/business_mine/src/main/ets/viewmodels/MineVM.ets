import { AccountUtil, AppStorageMap, RouterMap, RouterModule, UserInfoModel } from 'lib_foundation';
import { promptAction } from '@kit.ArkUI';

@ObservedV2
export class MineVM {
  @Trace userInfo: UserInfoModel = AccountUtil.getUserInfo();
  @Trace type: number = 1;

  @Monitor('type')
  private _typeChange() {
  }

  private static _instance: MineVM;

  public static get instance() {
    if (!MineVM._instance) {
      MineVM._instance = new MineVM();
    }
    return MineVM._instance;
  }

  public saveEdit(newName: string) {
    if (this._isLegal(newName)) {
      AccountUtil.updateName(newName);
      RouterModule.pop();
    }
  }

  public logout() {
    AccountUtil.resetInfo();
    promptAction.showToast({ message: '退出成功~！' });
    RouterModule.pop();
  }

  public getCurrentDateString(): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = weekdays[date.getDay()];
    return `${year}年${month}月${day}日周${weekday}`;
  }

  public getWeekDay(s: string): string {
    const parts = s.split('-');
    if (parts.length !== 3) {
      return '';
    }
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    d.setHours(0, 0, 0, 0);
    const diff = (d.getTime() - today.getTime()) / 86400000 | 0;
    if (diff === 1) {
      return '明天';
    }
    const w = d.getDay();
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][w];
  }

  public getIndicesParams() {
    const param = RouterModule.getNavParam({ url: RouterMap.INDICES }) as number | undefined;
    this.type = param ?? 1;
    this._typeChange();
  }

  private _isLegal(name: string) {
    if (!name) {
      promptAction.showToast({
        message: '昵称不能为空,长度限制为8位',
      });
      return false;
    }
    if (!(/^[a-zA-Z0-9\u4e00-\u9fa5]+$/).test(name)) {
      promptAction.showToast({
        message: '昵称只能包含字母、数字、中文',
      });
      return false;
    }
    return true;
  }
}