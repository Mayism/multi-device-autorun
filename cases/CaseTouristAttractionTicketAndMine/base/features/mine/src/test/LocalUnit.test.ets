import { describe, beforeAll, beforeEach, afterEach, afterAll, it, expect } from '@ohos/hypium';
import { AddressInfo, TouristInfo, TicketOrderInfo } from 'types';
import { createMockTouristList, createMockAddressList, createMockTicketOrderList } from './MockData';

export default function localUnitTest() {
  describe('TouristInfoTest', () => {
    let touristList: TouristInfo[] = [];

    beforeAll(() => {
      touristList = createMockTouristList();
    });

    it('touristList_length_should_be_3', 0, () => {
      expect(touristList.length).assertEqual(3);
    });

    it('tourist_first_item_id', 0, () => {
      expect(touristList[0].id).assertEqual('T001');
    });

    it('tourist_first_item_name', 0, () => {
      expect(touristList[0].name).assertEqual('张三');
    });

    it('tourist_first_item_phone', 0, () => {
      expect(touristList[0].phone).assertEqual('13800138001');
    });

    it('tourist_first_item_cardType', 0, () => {
      expect(touristList[0].cardType).assertEqual(0);
    });

    it('tourist_first_item_cardNo', 0, () => {
      expect(touristList[0].cardNo).assertEqual('110101199001011234');
    });

    it('tourist_first_item_isChecked', 0, () => {
      expect(touristList[0].isChecked).assertTrue();
    });

    it('tourist_second_item_name', 0, () => {
      expect(touristList[1].name).assertEqual('李四');
    });

    it('tourist_second_item_isChecked_false', 0, () => {
      expect(touristList[1].isChecked).assertFalse();
    });

    it('tourist_third_item_cardType_foreign', 0, () => {
      expect(touristList[2].cardType).assertEqual(1);
    });

    it('tourist_third_item_cardNo_passport', 0, () => {
      expect(touristList[2].cardNo).assertEqual('E12345678');
    });

    it('tourist_third_item_isChecked_true', 0, () => {
      expect(touristList[2].isChecked).assertTrue();
    });
  });

  describe('AddressInfoTest', () => {
    let addressList: AddressInfo[] = [];

    beforeAll(() => {
      addressList = createMockAddressList();
    });

    it('addressList_length_should_be_3', 0, () => {
      expect(addressList.length).assertEqual(3);
    });

    it('address_first_item_id', 0, () => {
      expect(addressList[0].id).assertEqual('A001');
    });

    it('address_first_item_name', 0, () => {
      expect(addressList[0].name).assertEqual('张三');
    });

    it('address_first_item_phone', 0, () => {
      expect(addressList[0].phone).assertEqual('13800138001');
    });

    it('address_first_item_district', 0, () => {
      expect(addressList[0].district).assertEqual('广东省深圳市南山区');
    });

    it('address_first_item_detail', 0, () => {
      expect(addressList[0].detail).assertEqual('科技园南路1号');
    });

    it('address_first_item_type_default', 0, () => {
      expect(addressList[0].type).assertEqual(1);
    });

    it('address_first_item_latitude', 0, () => {
      expect(addressList[0].latitude).assertEqual(22.5431);
    });

    it('address_first_item_longitude', 0, () => {
      expect(addressList[0].longitude).assertEqual(113.954);
    });

    it('address_second_item_district', 0, () => {
      expect(addressList[1].district).assertEqual('浙江省杭州市西湖区');
    });

    it('address_second_item_type_not_default', 0, () => {
      expect(addressList[1].type).assertEqual(0);
    });

    it('address_third_item_district_beijing', 0, () => {
      expect(addressList[2].district).assertEqual('北京市朝阳区');
    });

    it('address_default_address_count', 0, () => {
      let defaultCount: number = 0;
      addressList.forEach((item: AddressInfo) => {
        if (item.type === 1) {
          defaultCount++;
        }
      });
      expect(defaultCount).assertEqual(1);
    });
  });

  describe('TicketOrderInfoTest', () => {
    let orderList: TicketOrderInfo[] = [];

    beforeAll(() => {
      orderList = createMockTicketOrderList();
    });

    it('orderList_length_should_be_4', 0, () => {
      expect(orderList.length).assertEqual(4);
    });

    it('order_first_item_orderNo', 0, () => {
      expect(orderList[0].orderNo).assertEqual('TK20260101001');
    });

    it('order_first_item_orderTime', 0, () => {
      expect(orderList[0].orderTime).assertEqual('2026-01-01 10:00:00');
    });

    it('order_first_item_status_to_pay', 0, () => {
      expect(orderList[0].orderStatus).assertEqual(1);
    });

    it('order_first_item_count', 0, () => {
      expect(orderList[0].count).assertEqual(2);
    });

    it('order_first_item_touristId_length', 0, () => {
      expect(orderList[0].touristId.length).assertEqual(2);
    });

    it('order_first_item_touristId_contains_T001', 0, () => {
      expect(orderList[0].touristId[0]).assertEqual('T001');
    });

    it('order_first_item_touristId_contains_T002', 0, () => {
      expect(orderList[0].touristId[1]).assertEqual('T002');
    });

    it('order_first_item_productName', 0, () => {
      expect(orderList[0].productName).assertEqual('黄山风景区成人票');
    });

    it('order_first_item_productPrice', 0, () => {
      expect(orderList[0].productPrice).assertEqual(190);
    });

    it('order_first_item_amount', 0, () => {
      expect(orderList[0].amount).assertEqual(380);
    });

    it('order_first_item_discount', 0, () => {
      expect(orderList[0].discount).assertEqual(0);
    });

    it('order_second_item_status_to_use', 0, () => {
      expect(orderList[1].orderStatus).assertEqual(2);
    });

    it('order_second_item_has_discount', 0, () => {
      expect(orderList[1].discount).assertEqual(15);
    });

    it('order_second_item_isAddSchedule_true', 0, () => {
      expect(orderList[1].isAddSchedule).assertTrue();
    });

    it('order_third_item_status_completed', 0, () => {
      expect(orderList[2].orderStatus).assertEqual(3);
    });

    it('order_third_item_touristId_length', 0, () => {
      expect(orderList[2].touristId.length).assertEqual(3);
    });

    it('order_fourth_item_status_refunded', 0, () => {
      expect(orderList[3].orderStatus).assertEqual(4);
    });

    it('order_fourth_item_productName', 0, () => {
      expect(orderList[3].productName).assertEqual('长城门票');
    });
  });

  describe('OrderTypeCountTest', () => {
    let orderList: TicketOrderInfo[] = [];

    beforeAll(() => {
      orderList = createMockTicketOrderList();
    });

    it('to_pay_order_count', 0, () => {
      let count: number = 0;
      orderList.forEach((item: TicketOrderInfo) => {
        if (item.orderStatus === 1) {
          count++;
        }
      });
      expect(count).assertEqual(1);
    });

    it('to_use_order_count', 0, () => {
      let count: number = 0;
      orderList.forEach((item: TicketOrderInfo) => {
        if (item.orderStatus === 2) {
          count++;
        }
      });
      expect(count).assertEqual(1);
    });

    it('completed_order_count', 0, () => {
      let count: number = 0;
      orderList.forEach((item: TicketOrderInfo) => {
        if (item.orderStatus === 3) {
          count++;
        }
      });
      expect(count).assertEqual(1);
    });

    it('refunded_order_count', 0, () => {
      let count: number = 0;
      orderList.forEach((item: TicketOrderInfo) => {
        if (item.orderStatus === 4) {
          count++;
        }
      });
      expect(count).assertEqual(1);
    });
  });

  describe('AddressValidateTest', () => {
    let addressList: AddressInfo[] = [];

    beforeAll(() => {
      addressList = createMockAddressList();
    });

    it('address_name_not_empty', 0, () => {
      addressList.forEach((item: AddressInfo) => {
        expect(item.name.length > 0).assertTrue();
      });
    });

    it('address_phone_is_11_digits', 0, () => {
      addressList.forEach((item: AddressInfo) => {
        expect(item.phone.length).assertEqual(11);
      });
    });

    it('address_district_not_empty', 0, () => {
      addressList.forEach((item: AddressInfo) => {
        expect(item.district.length > 0).assertTrue();
      });
    });

    it('address_detail_not_empty', 0, () => {
      addressList.forEach((item: AddressInfo) => {
        expect(item.detail.length > 0).assertTrue();
      });
    });
  });

  describe('TouristOrderRelationTest', () => {
    let touristList: TouristInfo[] = [];
    let orderList: TicketOrderInfo[] = [];

    beforeAll(() => {
      touristList = createMockTouristList();
      orderList = createMockTicketOrderList();
    });

    it('order_touristId_exists_in_touristList', 0, () => {
      let touristIds: string[] = [];
      touristList.forEach((item: TouristInfo) => {
        touristIds.push(item.id);
      });
      orderList.forEach((order: TicketOrderInfo) => {
        order.touristId.forEach((tid: string) => {
          expect(touristIds.indexOf(tid) >= 0).assertTrue();
        });
      });
    });

    it('order_contactId_exists_in_touristList', 0, () => {
      let touristIds: string[] = [];
      touristList.forEach((item: TouristInfo) => {
        touristIds.push(item.id);
      });
      orderList.forEach((order: TicketOrderInfo) => {
        expect(touristIds.indexOf(order.contactId) >= 0).assertTrue();
      });
    });

    it('order_amount_equals_price_times_count', 0, () => {
      orderList.forEach((order: TicketOrderInfo) => {
        let expectedAmount: number = order.productPrice * order.count - order.discount;
        expect(order.amount).assertEqual(expectedAmount);
      });
    });
  });
}
