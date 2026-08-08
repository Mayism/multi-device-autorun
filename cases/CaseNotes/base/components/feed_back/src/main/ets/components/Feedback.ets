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

import { FeedbackItemType } from '../model/FeedbackRecordModel';
import { fileSelect, getDateStringWithTimeStamp } from '../utils/FileSelect';

@ComponentV2
export struct Feedback {
  text?: ResourceStr;
  //传入问题描述的最大字数
  @Param des: number = 100
  //传入问题截图需要的最大数量
  @Param num: number = 3
  //监听问题描述输入的长度
  @Local desLength: number = 0
  //监听电话号码输入的长度
  @Local phoneLength: number = 0
  //获取选择图片后的url数组
  @Local stageImageUris: Array<string> = [];
  @Local imageUris: Array<string> = [];
  @Local phoneValue: string = ''
  @Local feedList: FeedbackItemType = {
    description: '',
    stageImageUris: [],
    phone: '',
    time: ''
  }
  @Event butOnClick: (feedList: FeedbackItemType) => void;

  build() {
    Column(){
      Scroll(){
        Column() {
          // 问题描述
          this.feedDes()
          // 问题截图
          this.feedPic()
          // 联系方式
          this.feedPhone()
          Blank()
          .layoutWeight(1)
          // 提交按钮
          this.submitButton()
        }
        .width('100%')
      }
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .height('100%')
    .width('100%')
    .padding({
      top: 12,
      bottom: 12
    })
    .backgroundColor($r('sys.color.comp_background_gray'))
  }

  // 选择图像
  async selectImage() {
    let uris = await fileSelect(this.getUIContext(),this.stageImageUris, this.num - this.feedList.stageImageUris.length)
    this.imageUris.push(...uris)
    this.feedList.stageImageUris = this.imageUris
  }

  // 提交按钮
  @Builder
  submitButton() {
    Button('提交反馈')
      .borderRadius(20)
      .fontColor($r('sys.color.font_on_primary'))
      .backgroundColor('#FFAA00')
      .fontSize($r('sys.float.Body_L'))
      .fontWeight(FontWeight.Medium)
      .width('100%')
      .height(40)
      .padding({ top: 12, bottom: 12 })
      .margin({ top: 50, bottom: 44 })
      .onClick(async () => {
        if (this.feedList.description.length > 0) {
          if (this.phoneLength === 0 || this.phoneLength === 11) {
            //获取当前时间
            this.feedList.time = getDateStringWithTimeStamp()
            this.butOnClick(this.feedList)
          } else {
            this.getUIContext().getPromptAction().showToast({ message: '请输入11位正确的电话号码', duration: 2000 });
          }
        } else {
          this.getUIContext().getPromptAction().showToast({ message: '请填写问题描述', duration: 2000 });
        }
      })
  }

  // 问题描述
  @Builder
  feedDes() {
    Row() {
      Text('问题描述')
        .fontSize($r('sys.float.Body_M'))
        .fontWeight(FontWeight.Regular)
        .fontColor($r('sys.color.font_primary'))
      Text(`${this.desLength}/${this.des}`)
        .fontSize($r('sys.float.Body_M'))
        .fontWeight(FontWeight.Regular)
        .fontColor($r('sys.color.font_secondary'))
    }
    .width('100%')
    .height(20)
    .justifyContent(FlexAlign.SpaceBetween)
    .padding({ left: 4, right: 5 })
    .margin({ bottom: 13 })

    TextArea({ placeholder: '请输入问题描述' })
      .placeholderFont({ size: $r('sys.float.Body_S'), weight: 'regular' })
      .width('100%')
      .height(122)
      .backgroundColor($r('sys.color.comp_background_list_card'))
      .maxLength(this.des)
      .onChange((value: string) => {
        this.feedList.description = value
        this.desLength = value.length
      })
  }

  // 问题截图
  @Builder
  feedPic() {
    Row() {
      Text('问题截图（选填）')
        .fontSize($r('sys.float.Body_M'))
        .fontWeight(FontWeight.Regular)
        .fontColor($r('sys.color.font_primary'))
      Text(`${this.imageUris.length}/${this.num}`)
        .fontSize($r('sys.float.Body_M'))
        .fontWeight(FontWeight.Regular)
        .fontColor($r('sys.color.font_secondary'))
    }
    .width('100%')
    .height(20)
    .justifyContent(FlexAlign.SpaceBetween)
    .padding({ left: 4, right: 5 })
    .margin({ top: 12, bottom: 13 })

    Row() {
      ForEach(this.imageUris, (item: string, index: number) => {
        Stack({ alignContent: Alignment.TopEnd }) {
          Image(item ? item : $r('app.media.close_btn'))
            .width(80)
            .height(80)
            .objectFit(ImageFit.Cover)
            .borderRadius(5)
            .margin(5)
          Image($r('app.media.close_btn'))
            .width(20)
            .height(20)
            .margin({ right: 5, top: 5 })
            .onClick(() => {
              this.imageUris.splice(index, 1)
              this.feedList.stageImageUris.splice(index, 1)
            })
        }
      }, (item: string, index: number) => item + index)

      if (this.imageUris.length < this.num) {
        Row() {
          Image($r('app.media.ic_public_plus')).size({ height: 22, width: 22 })
        }
        .height(80)
        .width(80)
        .backgroundColor($r('sys.color.background_secondary'))
        .margin({ left: 12 })
        .justifyContent(FlexAlign.Center)
        .onClick(() => {
          this.selectImage()
        })
      }
    }
    .width('100%')
    .height(104)
    .backgroundColor($r('sys.color.comp_background_list_card'))
    .borderRadius(16)
    .justifyContent(FlexAlign.Start)
  }

  // 联系方式
  @Builder
  feedPhone() {
    Row() {
      Text('联系方式（选填）')
        .fontSize($r('sys.float.Body_M'))
        .fontWeight(FontWeight.Regular)
        .fontColor($r('sys.color.font_primary'))
      Text(`${this.phoneLength}/11`)
        .fontSize($r('sys.float.Body_M'))
        .fontWeight(FontWeight.Regular)
        .fontColor($r('sys.color.font_secondary'))
    }
    .width('100%')
    .height(20)
    .justifyContent(FlexAlign.SpaceBetween)
    .padding({ left: 4, right: 5 })
    .margin({ top: 12, bottom: 13 })

    TextInput({ placeholder: '请填写联系手机', text: this.text })
      .backgroundColor($r('sys.color.comp_background_primary'))
      .type(InputType.PhoneNumber)
      .maxLength(11)
      .placeholderFont({ size: $r('sys.float.Body_L'), weight: FontWeight.Regular })
      .onChange((value: string) => {
        this.phoneLength = value.length
        this.phoneValue = value
      })
      .onBlur(() => {
        if (this.phoneLength === 11 || this.phoneLength === 0) {
          this.feedList.phone = this.phoneValue
        } else {
          this.getUIContext().getPromptAction().showToast({ message: '请输入11位正确的电话号码', duration: 2000 });
        }
      })
      .onWillInsert((info: InsertValue) => {
        // 在将要输入时调用的回调。在返回true时，表示正常插入，返回false时，表示不插入。
        if (info.insertValue.startsWith(' ')) {
          return false
        } else {
          return true
        }
      })
  }
}

@Builder
export function FeedbackBuilder() {
  Feedback()
}
