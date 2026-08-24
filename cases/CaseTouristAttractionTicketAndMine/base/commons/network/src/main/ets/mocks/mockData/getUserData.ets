import { Constant } from 'common';
import { AddressListItem, GetAddressListResp } from '../../types/responseTypes/GetAddressListResp';
import { GetTicketOrderListResp, TicketOrderListItem } from '../../types/responseTypes/GetTicketOrderListResp';
import { GetTouristListResp, TouristListItem } from '../../types/responseTypes/GetTouristListResp';
import { MockResourceEnum } from '../MockResourceEnum';

export function createPresetTouristList(): GetTouristListResp {
  let list: TouristListItem[] = [{
    id: '1',
    name: '张三',
    phone: '13800138001',
    cardType: 0,
    cardNo: '110101199001011234',
    isChecked: true,
  }, {
    id: '2',
    name: '李四',
    phone: '13900139002',
    cardType: 0,
    cardNo: '310101199203032345',
    isChecked: false,
  }, {
    id: '3',
    name: '王五',
    phone: '15000150003',
    cardType: 1,
    cardNo: 'E12345678',
    isChecked: true,
  }];
  let resp: GetTouristListResp = new GetTouristListResp();
  resp.push(...list);
  return resp;
}

export function createPresetAddressList(): GetAddressListResp {
  let list: AddressListItem[] = [{
    id: '1',
    name: '张三',
    phone: '13800138001',
    district: '广东省深圳市南山区',
    detail: '科技园南路1号',
    type: 1,
    latitude: 22.5431,
    longitude: 113.954,
  }, {
    id: '2',
    name: '李四',
    phone: '13900139002',
    district: '浙江省杭州市西湖区',
    detail: '文三路100号',
    type: 0,
    latitude: 30.2741,
    longitude: 120.1551,
  }, {
    id: '3',
    name: '王五',
    phone: '15000150003',
    district: '北京市朝阳区',
    detail: '建国门外大街1号',
    type: 0,
    latitude: 39.9087,
    longitude: 116.3975,
  }];
  let resp: GetAddressListResp = new GetAddressListResp();
  resp.push(...list);
  return resp;
}

export function createPresetTicketOrderList(): GetTicketOrderListResp {
  let list: TicketOrderListItem[] = [{
    orderNo: 'TK20260101001',
    orderTime: '2026-01-01 10:00:00',
    orderStatus: 1,
    count: 2,
    touristId: ['1', '2'],
    contactId: '1',
    productName: '黄山风景区成人票',
    productPrice: 190,
    discount: 0,
    amount: 380,
    startTime: '2026-02-01',
    endTime: '2026-02-01',
    isAddSchedule: false,
    isAddSubscription: false,
  }, {
    orderNo: 'TK20260102002',
    orderTime: '2026-01-02 14:30:00',
    orderStatus: 2,
    count: 1,
    touristId: ['3'],
    contactId: '3',
    productName: '西湖景区联票',
    productPrice: 150,
    discount: 15,
    amount: 135,
    startTime: '2026-02-15',
    endTime: '2026-02-15',
    isAddSchedule: true,
    isAddSubscription: false,
  }, {
    orderNo: 'TK20260103003',
    orderTime: '2026-01-03 09:15:00',
    orderStatus: 3,
    count: 3,
    touristId: ['1', '2', '3'],
    contactId: '2',
    productName: '故宫博物院门票',
    productPrice: 60,
    discount: 0,
    amount: 180,
    startTime: '2026-01-10',
    endTime: '2026-01-10',
    isAddSchedule: false,
    isAddSubscription: false,
  }, {
    orderNo: 'TK20260104004',
    orderTime: '2025-12-20 16:00:00',
    orderStatus: 4,
    count: 1,
    touristId: ['1'],
    contactId: '1',
    productName: '长城门票',
    productPrice: 40,
    discount: 0,
    amount: 40,
    startTime: '2025-12-25',
    endTime: '2025-12-25',
    isAddSchedule: false,
    isAddSubscription: false,
  }];
  let resp: GetTicketOrderListResp = new GetTicketOrderListResp();
  resp.push(...list);
  return resp;
}
