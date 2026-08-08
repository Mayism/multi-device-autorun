/*
 * Copyright (c) 2024 Huawei Device Co., Ltd.
 * Licensed under the Apache License,Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

@Entry
@Component
struct NoteCard {
  @LocalStorageProp('totalNotesCount') totalNotesCount: number = 0;
  @LocalStorageProp('firstNoteTitle') firstNoteTitle: string = '';
  @LocalStorageProp('firstNoteTime') firstNoteTime: string = '';
  @LocalStorageProp('secondNoteTitle') secondNoteTitle: string = '';
  @LocalStorageProp('secondNoteTime') secondNoteTime: string = '';
  @LocalStorageProp('hasNotes') hasNotes: boolean = false;
  @LocalStorageProp('hasTwoNotes') hasTwoNotes: boolean = false;

  readonly actionType: string = 'router';
  readonly abilityName: string = 'EntryAbility';
  readonly fullWidthPercent: string = '100%';
  readonly fullHeightPercent: string = '100%';

  /**
   * 格式化时间戳为年月日格式
   */
  private formatTimestamp(timestampStr: string): string {
    if (!timestampStr || timestampStr.trim() === '') {
      return '';
    }

    try {
      // 将字符串时间戳转换为数字
      const timestamp = parseInt(timestampStr);
      if (isNaN(timestamp)) {
        return timestampStr;
      }

      // 创建Date对象
      const date = new Date(timestamp);

      // 格式化：YYYY-MM-dd 例如：2026-01-26
      const year = date.getFullYear().toString();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');

      return `${year}-${month}-${day}`;
    } catch (error) {
      return timestampStr; // 出错时返回原字符串
    }
  }

  @Builder  NoteItem(title: string, time: string, showDivider: boolean = false) {
    Column() {

      Row({ space: 8 }) {
        Image($r('app.media.triangle'))
          .width(2)
          .height(12)

        // 笔记标题
        Text(title || '无标题笔记')
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.font_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      .width('100%')
      .height(20)
      .padding({ left: 4, right: 12 })
      .justifyContent(FlexAlign.Start)
      .alignItems(VerticalAlign.Center)

      Row({ space: 8 }) {
        Text(this.formatTimestamp(time))
          .fontSize(12)
          .fontColor($r('sys.color.font_tertiary'))
          .layoutWeight(1)
      }
      .width('100%')
      .height(20)
      .padding({ left: 4, right: 12 })
      .justifyContent(FlexAlign.Start)
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding({ top: 2, bottom: 2 })
    .onClick(() => {
      this.navigateToHome();
    })
  }


  build() {
    Column() {
      // 顶部标题栏（增加四周间距）
      Row() {
        Image($r('app.media.appicon'))
          .width(24)
          .height(24)
          .margin({ right: 8 })

        Text('笔记')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.font_primary'))

      }
      .width('100%')
      .height(30)
      .margin({ left: 4 })

      .justifyContent(FlexAlign.Start)

      // 根据是否有笔记显示不同内容
      if (this.hasNotes) {
        Column({ space: 0 }) {
          Column() {
            Row({ space: 8 }) {
              Image($r('app.media.triangle'))
                .width(2)
                .height(12)

              // 笔记标题
              Text(this.firstNoteTitle || '无标题笔记')
                .fontSize(14)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('sys.color.font_primary'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
            }
            .width('100%')
            .height(20)
            .padding({ left: 4, right: 12 })
            .justifyContent(FlexAlign.Start)
            .alignItems(VerticalAlign.Center)

            Row({ space: 8 }) {
              Text(this.formatTimestamp(this.firstNoteTime))
                .fontSize(12)
                .fontColor($r('sys.color.font_tertiary'))
                .layoutWeight(1)
            }
            .width('100%')
            .height(20)
            .padding({ left: 4, right: 12 })
            .justifyContent(FlexAlign.Start)
            .alignItems(VerticalAlign.Center)
          }
          .width('100%')
          .padding({ top: 2, bottom: 2 })
          .onClick(() => {
            this.navigateToHome();
          })

          if (this.hasTwoNotes) {
            Column() {

              Row({ space: 8 }) {
                Image($r('app.media.triangle'))
                  .width(2)
                  .height(12)

                // 笔记标题
                Text(this.secondNoteTitle || '无标题笔记')
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .fontColor($r('sys.color.font_primary'))
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
              }
              .width('100%')
              .height(20)
              .padding({ left: 4, right: 12 })
              .justifyContent(FlexAlign.Start)
              .alignItems(VerticalAlign.Center)

              Row({ space: 8 }) {
                Text(this.formatTimestamp(this.secondNoteTime))
                  .fontSize(12)
                  .fontColor($r('sys.color.font_tertiary'))
                  .layoutWeight(1)
              }
              .width('100%')
              .height(20)
              .padding({ left: 4, right: 12 })
              .justifyContent(FlexAlign.Start)
              .alignItems(VerticalAlign.Center)
            }
            .width('100%')
            .padding({ top: 2, bottom: 2 })
            .onClick(() => {
              this.navigateToHome();
            })
          }
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.SpaceEvenly)
        .margin({ top: 2, bottom: 2 })
      } else {
        // 无笔记时的显示
        Column() {
          Image($r('app.media.nonote'))
            .width(60)
            .height(76)
            .margin({ bottom: 36 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      }
    }
    .width(this.fullWidthPercent)
    .height(this.fullHeightPercent)
    .backgroundColor($r('sys.color.comp_background_primary'))
    .padding({ left: 12, right: 12, top: 12, bottom: 12 })
    .onClick(() => {
      this.navigateToHome();
    });
  }

  /**
   * 跳转到首页
   */
  private navigateToHome(): void {
    postCardAction(this, {
      action: this.actionType,
      abilityName: this.abilityName,
      params: {
        targetPage: 'Index'
      },
    });
  }
}