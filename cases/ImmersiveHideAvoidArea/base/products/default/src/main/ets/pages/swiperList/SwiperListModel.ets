/*
 * Copyright (c) 2025 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export class BannerItem {
  title: string;
  color: ResourceColor;

  constructor(title: string, color: ResourceColor) {
    this.title = title;
    this.color = color;
  }
}

export class ItemData {
  title: string;
  description: string;
  iconColor: ResourceColor;

  constructor(title: string, description: string, iconColor: ResourceColor) {
    this.title = title;
    this.description = description;
    this.iconColor = iconColor;
  }
}

export const MOCK_BANNERS: BannerItem[] = [
  new BannerItem('精选活动 限时开启', '#FF5722'),
  new BannerItem('新人专享 好礼相送', '#4CAF50'),
  new BannerItem('品牌特卖 折扣直达', '#2196F3'),
  new BannerItem('会员尊享 多重权益', '#9C27B0')
];

export const MOCK_ITEMS: ItemData[] = [
  new ItemData('智能手表 Pro', '健康监测 运动追踪 续航持久', '#FF5722'),
  new ItemData('无线降噪耳机', '主动降噪 沉浸音质 轻盈佩戴', '#4CAF50'),
  new ItemData('便携蓝牙音箱', '360 环绕低音 防水设计', '#2196F3'),
  new ItemData('高速移动固态硬盘', '1TB 大容量 读写飞速', '#9C27B0'),
  new ItemData('机械键盘 客制化', '热插拔轴体 RGB 灯效', '#FF9800'),
  new ItemData('4K 高清显示器', '窄边广色域 护眼低蓝光', '#00BCD4'),
  new ItemData('智能扫地机器人', '激光导航 自动集尘', '#8BC34A'),
  new ItemData('空气炸锅 大容量', '无油烹饪 一键操作', '#F44336'),
  new ItemData('人体工学办公椅', '动态腰托 透气网布', '#3F51B5'),
  new ItemData('便携投影仪', '1080P 高清 内置电池', '#E91E63'),
  new ItemData('电动牙刷 声波式', '深度清洁 智能压感', '#009688'),
  new ItemData('保温杯 316 不锈钢', '长效保温 便携轻量', '#795548')
];
