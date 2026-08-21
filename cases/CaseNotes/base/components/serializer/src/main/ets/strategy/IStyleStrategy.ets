import { SerializedStyledStringValue } from '../types/Types';

/**
 * 策略接口：T 代表具体的系统样式类型 (如 TextStyle)，D 代表序列化后的 DTO 数据类型
 */
export default interface IStyleStrategy<T extends StyledStringValue, D extends SerializedStyledStringValue> {
  // 序列化：将系统对象 T 转为纯数据 D
  serialize(value: T): D;

  // 反序列化：将纯数据 D 还原为系统对象 T
  deserialize(data: D): T;
}