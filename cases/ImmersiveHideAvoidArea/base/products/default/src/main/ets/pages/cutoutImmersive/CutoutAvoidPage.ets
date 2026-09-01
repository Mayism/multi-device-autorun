/*
 * Copyright (c) 2025 Huawei Device Co., Ltd.
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

import { CommonConstants } from 'commons';

const PAGE_BG: ResourceColor = '#0A0A0A';

@Component
export struct CutoutAvoidPage {

  build() {
    NavDestination() {
      Column() {
        Column() {
          Text($r('app.string.cutout_title'))
            .fontSize(28)
            .fontWeight(FontWeight.Bold)
            .fontColor(Color.White);

          Text($r('app.string.cutout_desc'))
            .fontSize(15)
            .fontColor(Color.White)
            .opacity(0.8)
            .margin({ top: 12 });
        }
        .width(CommonConstants.FULL_PERCENT)
        .height(CommonConstants.FULL_PERCENT)
        .justifyContent(FlexAlign.Center)
        .id('CutoutAvoidContent')
      }
      .backgroundColor(PAGE_BG)
    }
    .hideTitleBar(true)
  }
}
