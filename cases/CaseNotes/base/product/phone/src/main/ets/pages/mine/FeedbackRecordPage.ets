/*
 * Copyright (c) 2024 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FeedbackItemType, PreferConstant, PreferenceUtil } from 'feed_back';

@Builder
export function FeedbackRecordPageBuilder() {
  FeedbackRecordPage();
}

@ComponentV2
export struct FeedbackRecordPage {
  @Local feedbackList: FeedbackItemType[] = []

  /**
   * 数据初始化
   */
  initData() {
    const context = this.getUIContext().getHostContext() as Context;
    const rawData = PreferenceUtil.getInstance(context).get(PreferConstant.FEEDBACK_RECORD, []);

    this.feedbackList = (Array.isArray(rawData) ? rawData : []);
  }

  aboutToAppear(): void {
    this.initData()
  }

  build() {
    NavDestination(){
      Column() {
        Column() {
          if (this.feedbackList.length > 0) {
            List() {
              ForEach(this.feedbackList, (item: FeedbackItemType) => {
                ListItem() {
                  Column() {
                    Text(item.time)
                      .fontSize($r('sys.float.Body_S'))
                      .fontWeight(FontWeight.Medium)
                      .fontColor($r('sys.color.font_primary'))
                    Text('问题描述')
                      .fontSize($r('sys.float.Body_L'))
                      .fontWeight(FontWeight.Medium)
                      .margin({ top: 12, bottom: 8 })
                    Text(item.description)
                      .fontSize($r('sys.float.Body_S'))
                      .fontWeight(FontWeight.Regular)
                      .fontColor($r('sys.color.font_secondary'))
                      .lineHeight(20)
                    Text('问题截图')
                      .fontSize($r('sys.float.Body_L'))
                      .fontWeight(FontWeight.Medium)
                      .margin({ top: 12, bottom: 8 })
                    Row() {
                      ForEach(item.stageImageUris,
                        (item1: string) => {
                          Image(item1).width(80).height(80).margin({ right: 8 })
                        }, (item1: string, index: number) => item1 + index)
                    }
                  }
                  .backgroundColor($r('sys.color.comp_background_list_card'))
                  .padding(12)
                  .margin({ bottom: 12 })
                  .width('100%')
                  .borderRadius(16)
                  .alignItems(HorizontalAlign.Start)
                }
              }, (item: FeedbackItemType) => JSON.stringify(item))
            }.scrollBar(BarState.Off)
          } else {
            // 没有数据 显示空
            Column() {
              Text('您还没有提交反馈记录')
                .width('100%')
                .height('100%')
                .fontColor($r('sys.color.font_primary'))
                .fontSize($r('sys.float.Body_M'))
                .fontWeight(FontWeight.Medium)
                .textAlign(TextAlign.Center)
            }.width('100%').height(120)
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
          }
        }
          .height('100%')
          .width('100%')
          .padding({
            top: 10,
            left: $r('sys.float.padding_level8'),
            right: $r('sys.float.padding_level8'),
          })
      }.height('100%').width('100%')
    }
    .title('反馈记录')
    .backgroundColor($r('sys.color.background_secondary'))


  }
}

