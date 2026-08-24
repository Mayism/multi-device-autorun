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

import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { promptAction } from '@kit.ArkUI';

/**
 * 获取当前时间
 * @returns
 */
export function getDateStringWithTimeStamp(): string {
  let timestamp = Date.now();
  let date = new Date(timestamp);
  const year = date.getFullYear();
  const month = ('0' + (date.getMonth() + 1)).slice(-2);
  const day = ('0' + date.getDate()).slice(-2);
  const hour = date.getHours();
  let minutes = date.getMinutes();
  const min = minutes < 10 ? '0' + minutes : String(minutes);
  let second = date.getSeconds();
  const sec = second < 10 ? '0' + second : String(second);
  const dayOfWeek = date.getDay();
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${year}.${month}.${day}  ${days[dayOfWeek]}  ${hour}:${min}:${sec}`;
}

/**
 * 选择图片
 * @param preselectedUris 传入图片数组
 * @param num 选择最大图片数量
 * @returns
 */
export async function fileSelect(uiContext: UIContext,
  preselectedUris: Array<string>, num: number): Promise<Array<string>> {
  // 设置打开picker的选项
  let photoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
  photoSelectOptions.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE; // 类型
  photoSelectOptions.maxSelectNumber = num; // 数量
  photoSelectOptions.preselectedUris = preselectedUris // 预先的uri
  // 推荐参数
  let recommendationOptions: photoAccessHelper.RecommendationOptions = {
    recommendationType: photoAccessHelper.RecommendationType.QR_CODE // 配置枚举类型，不同的枚举值，推荐不同种类的图片
  };
  photoSelectOptions.recommendationOptions = recommendationOptions; // 将推荐参数赋值给 photoSelectOptions.recommendationOptions
  let photoPicker = new photoAccessHelper.PhotoViewPicker(); // 创建picker
  try {
    let photoSelectResult = await photoPicker.select(photoSelectOptions); // 拉起图片选择框
    if (photoSelectResult && photoSelectResult.photoUris && photoSelectResult.photoUris.length > 0) {
      let imgUris = photoSelectResult.photoUris;
      for (let imgUri of imgUris) {
        if (imgUri.indexOf('media/Photo') < 0) {
          uiContext.getPromptAction().showToast({ message: '请选择图片进行上传' })
          return [];
        }
      }
      return imgUris;
    } else {
      return [];
    }
  } catch (err) {
    return [];
  }
}
