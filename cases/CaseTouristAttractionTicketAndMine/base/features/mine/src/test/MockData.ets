import { AddressInfo, TouristInfo, TicketOrderInfo } from 'types';

export function createMockTouristList(): TouristInfo[] {
  let tourist1: TouristInfo = new TouristInfo('T001');
  tourist1.name = '张三';
  tourist1.phone = '13800138001';
  tourist1.cardType = 0;
  tourist1.cardNo = '110101199001011234';
  tourist1.isChecked = true;

  let tourist2: TouristInfo = new TouristInfo('T002');
  tourist2.name = '李四';
  tourist2.phone = '13900139002';
  tourist2.cardType = 0;
  tourist2.cardNo = '310101199203032345';
  tourist2.isChecked = false;

  let tourist3: TouristInfo = new TouristInfo('T003');
  tourist3.name = '王五';
  tourist3.phone = '15000150003';
  tourist3.cardType = 1;
  tourist3.cardNo = 'E12345678';
  tourist3.isChecked = true;

  return [tourist1, tourist2, tourist3];
}

export function createMockAddressList(): AddressInfo[] {
  let address1: AddressInfo = new AddressInfo();
  address1.id = 'A001';
  address1.name = '张三';
  address1.phone = '13800138001';
  address1.district = '广东省深圳市南山区';
  address1.detail = '科技园南路1号';
  address1.type = 1;
  address1.latitude = 22.5431;
  address1.longitude = 113.9540;

  let address2: AddressInfo = new AddressInfo();
  address2.id = 'A002';
  address2.name = '李四';
  address2.phone = '13900139002';
  address2.district = '浙江省杭州市西湖区';
  address2.detail = '文三路100号';
  address2.type = 0;
  address2.latitude = 30.2741;
  address2.longitude = 120.1551;

  let address3: AddressInfo = new AddressInfo();
  address3.id = 'A003';
  address3.name = '王五';
  address3.phone = '15000150003';
  address3.district = '北京市朝阳区';
  address3.detail = '建国门外大街1号';
  address3.type = 0;
  address3.latitude = 39.9087;
  address3.longitude = 116.3975;

  return [address1, address2, address3];
}

export function createMockTicketOrderList(): TicketOrderInfo[] {
  let order1: TicketOrderInfo = new TicketOrderInfo();
  order1.orderNo = 'TK20260101001';
  order1.orderTime = '2026-01-01 10:00:00';
  order1.orderStatus = 1;
  order1.couponId = 0;
  order1.count = 2;
  order1.touristId = ['T001', 'T002'];
  order1.contactId = 'T001';
  order1.productName = '黄山风景区成人票';
  order1.productPrice = 190;
  order1.amount = 380;
  order1.startTime = '2026-02-01';
  order1.endTime = '2026-02-01';
  order1.discount = 0;
  order1.isAddSchedule = false;
  order1.isAddSubscription = false;

  let order2: TicketOrderInfo = new TicketOrderInfo();
  order2.orderNo = 'TK20260102002';
  order2.orderTime = '2026-01-02 14:30:00';
  order2.orderStatus = 2;
  order2.couponId = 1;
  order2.count = 1;
  order2.touristId = ['T003'];
  order2.contactId = 'T003';
  order2.productName = '西湖景区联票';
  order2.productPrice = 150;
  order2.amount = 135;
  order2.startTime = '2026-02-15';
  order2.endTime = '2026-02-15';
  order2.discount = 15;
  order2.isAddSchedule = true;
  order2.isAddSubscription = false;

  let order3: TicketOrderInfo = new TicketOrderInfo();
  order3.orderNo = 'TK20260103003';
  order3.orderTime = '2026-01-03 09:15:00';
  order3.orderStatus = 3;
  order3.couponId = 0;
  order3.count = 3;
  order3.touristId = ['T001', 'T002', 'T003'];
  order3.contactId = 'T002';
  order3.productName = '故宫博物院门票';
  order3.productPrice = 60;
  order3.amount = 180;
  order3.startTime = '2026-01-10';
  order3.endTime = '2026-01-10';
  order3.discount = 0;
  order3.isAddSchedule = false;
  order3.isAddSubscription = false;

  let order4: TicketOrderInfo = new TicketOrderInfo();
  order4.orderNo = 'TK20260104004';
  order4.orderTime = '2025-12-20 16:00:00';
  order4.orderStatus = 4;
  order4.couponId = 2;
  order4.count = 1;
  order4.touristId = ['T001'];
  order4.contactId = 'T001';
  order4.productName = '长城门票';
  order4.productPrice = 40;
  order4.amount = 40;
  order4.startTime = '2025-12-25';
  order4.endTime = '2025-12-25';
  order4.discount = 0;
  order4.isAddSchedule = false;
  order4.isAddSubscription = false;

  return [order1, order2, order3, order4];
}
