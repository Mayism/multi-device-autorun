import { preferences } from '@kit.ArkData';
import { BusinessError, commonEventManager } from '@kit.BasicServicesKit';
import { LocationInfo } from 'lib_foundation';
import { Logger } from 'lib_foundation/src/main/ets/utils/Logger';

const TAG = '[WidgetUtil]';

export class WidgetUtil {
  private static readonly _fileName: string = 'file_name';
  private static readonly _formIdKey: string = 'id_key';
  private static readonly _locationKey: string = 'location_key';
  private static readonly _formIdEventName: string = 'form_id_event_name';

  public static getFormIds(ctx: Context) {
    const store = WidgetUtil._getStore(ctx);
    return store.getSync(WidgetUtil._formIdKey, []) as string[];
  }

  public static async addFormId(formId: string, cxt: Context) {
    const list = WidgetUtil.getFormIds(cxt);
    if (!list.some(id => id === formId)) {
      list.push(formId);
      const store = WidgetUtil._getStore(cxt);
      store.putSync(WidgetUtil._formIdKey, list);
      await store.flush();
    }
  }

  public static async delFormId(formId: string, cxt: Context) {
    const list = WidgetUtil.getFormIds(cxt);
    const index = list.findIndex(id => id === formId);
    if (index !== -1) {
      list.splice(index, 1);
      const store = WidgetUtil._getStore(cxt);
      store.putSync(WidgetUtil._formIdKey, list);
      await store.flush();
    }
  }

  // 发布公共事件跨进程传递卡片id
  public static publishFormId(formId: string, isDelete: boolean) {
    commonEventManager.publish(WidgetUtil._formIdEventName, { data: formId, parameters: { isDelete } },
      (err: BusinessError) => {
        if (err) {
          Logger.error(TAG, `Failed to publish common event. Code is ${err.code}, message is ${err.message}`);
        } else {
          Logger.info(TAG, 'Succeeded in publishing common event.');
        }
      });
  }

  // 订阅获取卡片id
  public static async subscribeFormId(ctx: Context) {
    let subscriber: commonEventManager.CommonEventSubscriber;
    let subscribeInfo: commonEventManager.CommonEventSubscribeInfo = {
      events: [WidgetUtil._formIdEventName],
      publisherPermission: '',
    };
    commonEventManager.createSubscriber(subscribeInfo, (err1, data1) => {
      if (err1) {
        Logger.error(TAG, `Failed to create subscriber. Code is ${err1.code}, message is ${err1.message}`);
        return;
      }
      subscriber = data1;
      // 订阅公共事件回调
      commonEventManager.subscribe(subscriber, (err2, data2) => {
        if (err2) {
          Logger.error(TAG, `Failed to subscribe common event. Code is ${err2.code}, message is ${err2.message}`);
          return;
        } else {
          if (data2.parameters?.isDelete) {
            WidgetUtil.delFormId(data2.data as string, ctx);
          } else {
            WidgetUtil.addFormId(data2.data as string, ctx);
          }
          Logger.info(TAG, 'Succeeded in creating subscriber1.');
        }
      });
    });
  }

  public static getLocation(ctx: Context) {
    const store = WidgetUtil._getStore(ctx);
    return store.getSync(WidgetUtil._locationKey, []) as LocationInfo;
  }

  public static async setLocation(location: LocationInfo, ctx: Context) {
    const store = WidgetUtil._getStore(ctx);
    store.put(WidgetUtil._locationKey, location);
    store.flush();
  }


  private static _isDaytime(): boolean {
    const time = new Date();
    const hours = time.getHours();
    return hours >= 6 && hours < 18;
  }

  private static _getStore(ctx: Context) {
    return preferences.getPreferencesSync(ctx, { name: WidgetUtil._fileName });
  }
}