import { Constant } from 'common';
import { https } from 'network';
import { AsWebRichText, TitleBar } from 'uicomponents';
import { mapperBulletinInfo } from '../mapper/Index';
import { BulletinInfo } from '../model/BulletinInfo';

@Builder
export function BulletinDetailBuilder() {
  BulletinDetail();
}

@ComponentV2
export struct BulletinDetail {
  @Local bulletinId: number = 0;
  @Local bulletinInfo: BulletinInfo = new BulletinInfo();
  @Consumer('mainPathStack') mainPathStack: NavPathStack = new NavPathStack();

  getBulletinById() {
    https.getBulletinDetail(this.bulletinId).then((res) => {
      this.bulletinInfo = mapperBulletinInfo(res.data);
      this.bulletinInfo.detail =
        `<meta name="viewport" content="width=device-width, initial-scale=1.0">${this.bulletinInfo.detail}`;
    });
  }

  build() {
    NavDestination() {
      Column() {
        TitleBar({
          isShowBack: true, title: '资讯详情', clickEvent: () => {
            this.mainPathStack.pop();
          },
        });

        Scroll() {
          GridRow({ columns: 4, gutter: { x: 8 }, direction: GridRowDirection.Row }) {
            GridCol({
              span: 4,
              offset: 0,
            }) {
              Column({ space: 24 }) {
                Column({ space: 4 }) {
                  Text(this.bulletinInfo.title)
                    .maxLines(2)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .fontWeight(FontWeight.Bold)
                    .fontColor($r('sys.color.font_primary'))
                    .fontSize($r('sys.float.Subtitle_L'));

                  Text(`时间：${this.bulletinInfo.releaseTime}`)
                    .fontSize($r('sys.float.Body_S'))
                    .fontColor($r('sys.color.font_secondary'));
                }.alignItems(HorizontalAlign.Start).width(Constant.FULL_PERCENT);

                if (this.bulletinInfo.detail) {
                  Column() {
                    AsWebRichText({ url: Constant.RICH_TEXT_URI, richTextStr: this.bulletinInfo.detail })
                      .layoutWeight(1);
                  }.alignItems(HorizontalAlign.Start).width(Constant.FULL_PERCENT).layoutWeight(1);
                }
              };
            };
          };
        }
        .padding({ top: 12, bottom: 16 })
        .margin({ left: 16, right: 16 })
        .layoutWeight(1)
        .align(Alignment.Top);
      };
    }.hideTitleBar(true).onReady((context: NavDestinationContext) => {
      this.bulletinId = context.pathInfo.param as number;
      this.getBulletinById();
    });
  }
}
