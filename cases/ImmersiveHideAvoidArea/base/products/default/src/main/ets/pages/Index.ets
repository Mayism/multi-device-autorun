/*
 * Copyright (c) 2024 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 ("the License");
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
import { Shopping } from './backgroundImmersive/componentBackgroundImmersive/Shopping';
import { ROUTES, Route } from '../constants/Constants';
import { FullScreenPage } from './fullScreenImmersive/FullScreenPage';
import { CutoutAvoidPage } from './cutoutImmersive/CutoutAvoidPage';
import { SwiperListPage } from './swiperList/SwiperListPage';

@Entry
@Component
struct Index {
  @Provide navPageInfos: NavPathStack = new NavPathStack();

  // [Start nav_destination_builder]
  // 根据路由名称映射到目标页面；pushPath(name) 触发时由此 builder 决定渲染哪个 NavDestination。
  @Builder
  PageMap(name: string) {
    if (name === 'Shopping') {
      Shopping()
    } else if (name === 'FullScreen') {
      FullScreenPage()
    } else if (name === 'Cutout') {
      CutoutAvoidPage()
    } else if (name === 'SwiperList') {
      SwiperListPage()
    }
  }
  // [End nav_destination_builder]

  build() {
    Navigation(this.navPageInfos) {
      List({ space: 12 }) {
        ForEach(ROUTES, (route: Route) => {
          ListItem() {
            Text(route.title)
              .fontSize(18)
              .fontColor('#FF222222')
              .padding(16)
              .width('100%')
              .backgroundColor(Color.White)
              .borderRadius(12)
              .id(route.to)
              .onClick(() => {
                this.navPageInfos.pushPath({ name: route.to });
              })
          }
        }, (route: Route) => route.to)
      }
      .width('100%')
      .height('100%')
      .padding(12)
      .backgroundColor('#F1F3F5')
    }
    .navDestination(this.PageMap)
    .hideToolBar(true)
    .hideTitleBar(true)
    .id('IndexEntry')
  }
}
