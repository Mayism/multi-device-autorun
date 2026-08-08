import { NoteService } from '@ohos_agcit/notes_datasource';
import { Note } from 'richeditor';
import { SelectedController } from '../controller/SelectedController';
import { ThemeController } from '../controller/ThemeController';
import { KVStore, SerializeUtil } from 'serializer';

@Builder
export function DeleteNoteDialogBuilder() {
  DeleteNoteDialog();
}

/**
 * 确认删除笔记弹窗
 */
@ComponentV2
export struct DeleteNoteDialog {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();
  @Consumer() kvStore: KVStore | undefined = undefined;
  uiContext: UIContext = this.getUIContext() as UIContext;
  private themeController: ThemeController = ThemeController.instance
  private noteService: NoteService = NoteService.instance;
  private selectedController: SelectedController = SelectedController.instance;
  @Local deleteNoteList: Note[] = [];

  /**
   * 关闭转场动画
   */
  aboutToAppear(): void {
    this.appPathStack.disableAnimation(true);
  }

  build() {
    NavDestination() {
      Stack({ alignContent: Alignment.Center }) {
        Column({ space: 18 }) {
          Text('确认删除')
            .fontSize(20)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.font_primary'))

          Column(){
            Text('请确认是否删除,')
              .fontSize(14)
              .fontColor($r('sys.color.font_primary'))

            Text('已删除的笔记可以在回收站中查看')
              .fontSize(14)
              .fontColor($r('sys.color.font_primary'))
          }

          Flex({justifyContent: FlexAlign.SpaceAround}){
            Row(){
              Text('取消')
                .fontColor($r('sys.color.icon_emphasize'))
                .fontSize(16)
            }
            .justifyContent(FlexAlign.Center)
            .width('50%')
            .onClick(() => {
              this.appPathStack.pop();
            })

            Row(){
              Text('确定')
                .fontColor($r('sys.color.icon_emphasize'))
                .fontSize(16)
            }
            .justifyContent(FlexAlign.Center)
            .width('50%')
            .onClick(() => {
              this.noteService.deleteNotesToTrash(this.deleteNoteList, this.kvStore, this.uiContext);
              this.selectedController.recoverInitState();
              this.appPathStack.pop();
            })
          }
          .padding({
            top: 10
          })
        }
        .justifyContent(FlexAlign.Center)
        .backgroundColor(this.themeController.dialogBgWhite)
        .borderRadius(32)
        .height(158)
        .width('92%')
      }
      .height('100%')
      .width('100%')
    }
    .onReady((cxt: NavDestinationContext) => {
      let params = cxt.pathInfo.param as Record<string, Object>;
      if (params && params !== null) {
        this.deleteNoteList = params.noteList as Note[];
      }
    })
    .backgroundColor($r('sys.color.mask_fourth'))
    .hideTitleBar(true)
    .mode(NavDestinationMode.DIALOG);
  }
}