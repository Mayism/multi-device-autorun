import { UserInfo } from 'base_common';
import { BusinessError, emitter } from '@kit.BasicServicesKit';
import { Constants } from '../constant/Constants';
import { common, Want } from '@kit.AbilityKit';

@ObservedV2
export class SliderList {
  @Trace sliderList: SliderModel[] = [];

  calculateTomorrowDate(date: number) {
    let today = new Date()
    let next = new Date(today)
    next.setDate(today.getDate() + date) // 增加一天

    // 格式化月份和日期
    const MONTH = (next.getMonth() + 1).toString()
    const DAY = next.getDate().toString()
    let nextDate = `${MONTH}.${DAY}`
    return nextDate;
  }

  constructor() {
    this.sliderList = [
      new SliderModel(10, Constants.DATE, false),
      new SliderModel(20, this.calculateTomorrowDate(1), false),
      new SliderModel(30, this.calculateTomorrowDate(2), false),
      new SliderModel(30, this.calculateTomorrowDate(3), false),
      new SliderModel(40, this.calculateTomorrowDate(4), false),
      new SliderModel(40, this.calculateTomorrowDate(5), false),
      new SliderModel(50, this.calculateTomorrowDate(6), false),
    ]
  }
}

@ObservedV2
export class SliderModel {
  @Trace value: number
  @Trace day: ResourceStr
  @Trace isClick: boolean

  constructor(value: number, day: string | Resource, isClick: boolean) {
    this.value = value;
    this.day = day;
    this.isClick = isClick;
  }
}

@ObservedV2
export class TaskList {
  @Trace taskList: TaskCoins[] = [];

  constructor() {
    let userInfo: UserInfo = AppStorage.get('userInfo') as UserInfo;
    let uiContext: UIContext = AppStorage.get('uiContext') as UIContext;
    this.taskList =
      [new TaskCoins('天天领书币', '立得100金币', 100, '去领取', '已完成', 0, 1, true, (item: TaskCoins) => {
        if (userInfo?.bookCoins) {
          try {
            userInfo.bookCoins += 100
            emitter.emit(Constants.COINS_CHANGE)
            item.finished++;
            uiContext.getPromptAction().showToast({ message: '已领取成功' })
          } catch (error) {
            console.error('Failed to emitter emit coins change. Cause: ' + JSON.stringify(error));
          }
        }
      }), new TaskCoins('下载菜谱App', '做任务立得100书币', 100, '去下载', '已完成', 0, 1, true, (item: TaskCoins) => {
          try {
            const want: Want = {
              uri: `store://appgallery.huawei.com/app/`
            };
            const context = uiContext.getHostContext() as common.UIAbilityContext;
            context.startAbility(want, (err: BusinessError) => {
              if (err.code) {
                console.error(`Failed to startAbility. Code: ${err.code}, message: ${err.message}`);
              }
            })
            userInfo.bookCoins += 100
            emitter.emit(Constants.COINS_CHANGE)
            item.finished++;
          } catch (error) {
            console.error('Failed to emitter emit coins change. Cause: ' + JSON.stringify(error));
          }
        })]
  }
}

@ObservedV2
export class TaskCoins {
  @Trace title?: string = '';
  @Trace description?: string = '';
  @Trace coins?: number = 10;
  @Trace buttonOn?: string = '';
  @Trace buttonOff?: string = '';
  @Trace finished: number = 0;
  @Trace allFinish: number = 1;
  @Trace buttonState?: boolean = true;
  @Trace event?: (finished: TaskCoins) => void = () => {
  }

  constructor(title?: string, description?: string, coins?: number, buttonOn?: string, buttonOff?: string,
    finished: number = 0, allFinish: number = 1, buttonState?: boolean, event?: (finished: TaskCoins) => void) {
    this.title = title;
    this.description = description;
    this.coins = coins;
    this.buttonOn = buttonOn;
    this.buttonOff = buttonOff;
    this.finished = finished;
    this.allFinish = allFinish;
    this.buttonState = buttonState;
    this.event = event;
  }
}