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

import { BannerItem, ItemData, MOCK_BANNERS, MOCK_ITEMS } from './SwiperListModel';

const PAGE_BG: ResourceColor = '#F1F3F5';
const CARD_BG: ResourceColor = Color.White;
const ICON_SIZE: number = 44;
const BANNER_HEIGHT: number = 180;

@Component
export struct SwiperListPage {
  private bannerList: BannerItem[] = MOCK_BANNERS;
  private itemList: ItemData[] = MOCK_ITEMS;

  @Builder
  bannerBuilder(item: BannerItem) {
    Column() {
      Text(item.title)
        .fontSize(26)
        .fontColor(Color.White)
        .fontWeight(FontWeight.Bold)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(item.color)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  itemBuilder(item: ItemData) {
    Row({ space: 12 }) {
      Row()
        .width(ICON_SIZE)
        .height(ICON_SIZE)
        .backgroundColor(item.iconColor)
        .borderRadius(ICON_SIZE / 2)

      Column({ space: 6 }) {
        Text(item.title)
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor('#FF222222')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })

        Text(item.description)
          .fontSize(13)
          .fontColor('#99000000')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .padding(14)
    .backgroundColor(CARD_BG)
    .borderRadius(12)
  }

  build() {
    NavDestination() {
      Column() {
        Swiper() {
          ForEach(this.bannerList, (item: BannerItem) => {
            this.bannerBuilder(item)
          }, (item: BannerItem) => item.title)
        }
        .height(BANNER_HEIGHT)
        .width('100%')
        .loop(true)
        .indicator(true)
        .margin({ bottom: 4 })
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP])
        .clip(false)
        .id('SwiperBanner')

        List({ space: 12 }) {
          ForEach(this.itemList, (item: ItemData) => {
            ListItem() {
              this.itemBuilder(item)
            }
          }, (item: ItemData) => item.title)
        }
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
        .id('SwiperListView')
      }
      .width('100%')
      .background(PAGE_BG)
      .id('SwiperListContainer')
    }
    .hideTitleBar(true)
  }
}
