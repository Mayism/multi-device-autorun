import { Logger } from '@hw-agconnect/ui-base';
import { Decimal } from '@kit.ArkTS';
import { RechargeRecord } from '../model/Member';

@ObservedV2
export class RechargeRecordVM {
  @Trace rechargeRecords: RechargeRecord[] = [];
  @Trace isLoading: boolean = false;

  // 获取充值记录
  getRechargeRecords() {
    this.isLoading = true;
    try {
      // 从持久化存储获取充值记录
      const recordsStr = AppStorage.get<string>('rechargeRecords');
      if (recordsStr) {
        this.rechargeRecords = JSON.parse(recordsStr) as RechargeRecord[];
        // 按时间倒序排列
        this.rechargeRecords.sort((a, b) => b.timestamp - a.timestamp);
      } else {
        // 持久化存储无记录时，种入 mock 充值记录（用于演示/UITest）并持久化
        this.rechargeRecords = RechargeRecordVM.mockRechargeRecords();
        AppStorage.setOrCreate('rechargeRecords', JSON.stringify(this.rechargeRecords));
      }
    } catch (error) {
      Logger.error('获取充值记录失败:', error);
      this.rechargeRecords = [];
    } finally {
      this.isLoading = false;
    }
  }

  // mock 充值记录（演示/UITest 用，按时间倒序）
  static mockRechargeRecords(): RechargeRecord[] {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const records: RechargeRecord[] = [
      {
        id: `${now}_3`,
        orderId: 'ORD2026072809001',
        coins: 60,
        bonus: 0,
        totalCoins: 60,
        amount: 6,
        timestamp: now - 7 * day,
        date: RechargeRecordVM.formatDateTime(now - 7 * day),
      } as RechargeRecord,
      {
        id: `${now}_2`,
        orderId: 'ORD2026080115002',
        coins: 300,
        bonus: 60,
        totalCoins: 360,
        amount: 30,
        timestamp: now - 3 * day,
        date: RechargeRecordVM.formatDateTime(now - 3 * day),
      } as RechargeRecord,
      {
        id: `${now}_1`,
        orderId: 'ORD2026080310001',
        coins: 680,
        bonus: 220,
        totalCoins: 900,
        amount: 68,
        timestamp: now - day,
        date: RechargeRecordVM.formatDateTime(now - day),
      } as RechargeRecord,
    ];
    return records.sort((a, b) => b.timestamp - a.timestamp);
  }

  // 保存充值记录
  static saveRechargeRecord(record: RechargeRecord) {
    try {
      // 获取现有记录
      const recordsStr = AppStorage.get<string>('rechargeRecords');
      let records: RechargeRecord[] = [];
      if (recordsStr) {
        records = JSON.parse(recordsStr) as RechargeRecord[];
      }
      
      // 添加新记录
      records.unshift(record);
      
      // 保存到持久化存储
      AppStorage.setOrCreate('rechargeRecords', JSON.stringify(records));
      
      Logger.info('充值记录保存成功:'+ record);
    } catch (error) {
      Logger.error('保存充值记录失败:', error);

    }
  }

  // 生成订单号
  static generateOrderId(): string {
    const timestamp = Date.now();
    let random: string;
    try {
      random = Decimal.random().d[0].toString();
    } catch (e) {
      console.error('RechargeRecordVM', `generateOrderId random failed: ${e}`);
      random = '0';
    }
    return random;
  }

  // 格式化日期时间
  static formatDateTime(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }
} 