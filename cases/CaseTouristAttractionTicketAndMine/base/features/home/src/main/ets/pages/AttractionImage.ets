import { Constant } from 'common';
import { ImagePreview, ImagePreviewOptions, SourceImageModel } from 'image_preview';
import { TitleBar } from 'uicomponents';

@Builder
export function AttractionImageBuilder() {
  AttractionImage();
}

@ComponentV2
export struct AttractionImage {
  @Local detailImages: ResourceStr[] = [];
  @Consumer('mainPathStack') mainPathStack: NavPathStack = new NavPathStack();
  @Local resources: SourceImageModel[] = [];
  options: ImagePreviewOptions = new ImagePreviewOptions();

  build() {
    NavDestination() {
      Column() {
        TitleBar({
          isShowBack: true, title: '图片/视频', clickEvent: () => {
            this.mainPathStack.pop();
          },
        });

        Grid() {
          ForEach(this.detailImages, (item: ResourceStr, index: number) => {
            GridItem() {
              Image(item)
                .width('100%')
                .aspectRatio(1)
                .objectFit(ImageFit.Cover)
                .id(this.options.snapshotId(item, index))
                .onClick(() => {
                  this.options
                    .setImageList(this.resources)
                    .setInitIndex(index);
                  ImagePreview.open(this.getUIContext(), this.options);
                });
            };
          }, (item: ResourceStr) => item.toString());
        }
        .columnsTemplate('1fr '.repeat(3))
        .columnsGap(8)
        .rowsGap(2)
        .width(Constant.FULL_PERCENT)
        .padding({ left: 16, right: 16, top: 8 });
      };
    }.hideTitleBar(true).onReady((context: NavDestinationContext) => {
      this.detailImages = context.pathInfo.param as ResourceStr[];
      this.resources = this.detailImages.map((imageUrl) => {
        return new SourceImageModel({ imageUrl });
      });
    });
  }
}
