import { Category, CategoryService, NoteService } from '@ohos_agcit/notes_datasource';
import { DialogUtil, StringUtil } from '@ohos_agcit/notes_utils';
import { ComponentContent, UIContext } from '@kit.ArkUI';
import { SelectedController } from '../controller/SelectedController';
import { Note } from 'richeditor';
import { KVStore } from 'serializer';

@Builder
export function EditCategoryBuilder() {
  EditCategory();
}


@ComponentV2
export struct EditCategory {
  private scroller: ListScroller = new ListScroller();
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();
  @Consumer() kvStore: KVStore | undefined = undefined;
  uiContext: UIContext = this.getUIContext() as UIContext;
  categoryService: CategoryService = CategoryService.instance;
  noteService: NoteService = NoteService.instance;
  private selectedController: SelectedController = SelectedController.instance;
  @Local categoryList: Array<Category> = [];
  @Local categoryId: string = '';
  @Local isEditCategoryName: boolean = true;
  @Local isEditCategory: boolean = true;
  @Local currentCategory: Category = this.categoryService.getFirstCategory();
  ;
  @Local noteList: Note[] | undefined;

  selectFontColor(item: Category): ResourceStr {
    if (this.isEditCategory) {
      return this.currentCategory.id === item.id ? $r('sys.color.font_primary') : $r('sys.color.font_secondary');
    }

    return this.noteList?.find(note => note.categoryId === item.id) ?
      $r('sys.color.font_tertiary') : $r('sys.color.font_secondary');
  }

  selectFontWeight(item: Category): FontWeight {
    if (this.isEditCategory) {
      return this.currentCategory.id === item.id ? FontWeight.Medium : FontWeight.Regular;
    }
    return this.noteList?.find(note => note.categoryId === item.id) ? FontWeight.Medium : FontWeight.Regular;
  }

  /**
   * 右滑样式设置
   * @param item
   */
  @Builder
  categoryEnd(item: Category) {
    Row() {
      Image($r('app.media.edit_category'))
        .width(40)
        .height(40)
        .margin({ left: 16, right: 16 })
        .onClick(() => {
          this.isEditCategoryName = true;
          this.categoryId = item.id;

          let contentNode: ComponentContent<object> =
            new ComponentContent(this.getUIContext(), wrapBuilder(editCategoryDialog),
              new EditCategoryParam(this.isEditCategoryName,
                this.categoryService.getCategoryById(this.categoryId), this.scroller, this.kvStore!, this.uiContext));
          DialogUtil.openDialog(this.getUIContext(), contentNode);
        })

      Image($r('app.media.delete_category'))
        .width(40)
        .height(40)
        .onClick(() => {
          this.categoryId = item.id;
          let contentNode: ComponentContent<object> =
            new ComponentContent(this.getUIContext(), wrapBuilder(deleteCategoryDialog),
              new DeleteCategoryParam(this.categoryId, this.scroller, this.kvStore!, this.uiContext));
          DialogUtil.openDialog(this.getUIContext(), contentNode);
        })
    }
    .width(112)
    .height(48)
  }

  build() {
    NavDestination() {
      Scroll() {
        Column({ space: 15 }) {
          // "全部笔记"独占一列，不参与多列布局
          Row() {
            Text(this.categoryService.getFirstCategory().name)
              .fontSize(18)
              .fontColor(this.selectFontColor(this.categoryService.getFirstCategory()))
              .fontWeight(this.selectFontWeight(this.categoryService.getFirstCategory()))
            Blank();
            Text(String(this.categoryService.getFirstCategory().totalCount))
              .fontSize(18)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('sys.color.font_primary'))
          }
          .borderRadius(16)
          .backgroundColor(!this.isEditCategory && this.partOfNoteList('-1') ?
            $r('sys.color.background_tertiary') : $r('sys.color.comp_background_list_card'))
          .height(48)
          .width('100%')
          .padding({
            left: '3%',
            right: '3%',
          })

          // 普通分类列表：单列
          List({ space: 12, scroller: this.scroller }) {
            ForEach(this.normalCategories, (item: Category, index: number) => {
              ListItem() {
                Row() {
                  Text(item.name)
                    .fontSize(18)
                    .fontColor(this.selectFontColor(item))
                    .fontWeight(this.selectFontWeight(item))
                  Blank();
                  Text(String(item.totalCount))
                    .fontSize(18)
                    .fontWeight(FontWeight.Medium)
                    .fontColor($r('sys.color.font_primary'))
                }
                .borderRadius(16)
                .backgroundColor(!this.isEditCategory && this.partOfNoteList(item.id) ?
                  $r('sys.color.background_tertiary') : $r('sys.color.comp_background_list_card'))
                .height(48)
                .width('100%')
                .padding({
                  left: '3%',
                  right: '3%',
                })
              }
              .id(index === 0 ? 'category_item_0' : '')
              .swipeAction({
                end: {
                  builder: () => {
                    this.categoryEnd(item)
                  }
                }
              })
              .onClick(() => {
                // 非编辑模式
                if (!this.isEditCategory && this.noteList) {
                  // 移动分类
                  this.noteList.forEach(note => {
                    this.categoryService.moveCategory(note, item.id, this.kvStore!, this.uiContext);
                    note.categoryId = item.id;
                    note.isSelected = false;
                  })
                  this.noteList.forEach(note => {
                    this.noteService.updateNote(note);
                  })
                  this.selectedController.recoverInitState()
                  this.appPathStack.pop();
                }
              })
            }, (item: Category) => item.id);
          }
          .id('category_list')
          .lanes(1, 12)
          .scrollBar(BarState.Off)


          Row({ space: 8 }) {
            Image($r('app.media.create_category'))
              .width(24)
              .height(24)
            Text('新建分类')
              .fontSize(18)
              .fontColor($r('sys.color.font_secondary'))
          }
          .justifyContent(FlexAlign.Center)
          .backgroundColor($r('sys.color.comp_background_list_card'))
          .borderRadius(16)
          .height(48)
          .width('100%')
          .onClick(() => {
            this.isEditCategoryName = false;
            let contentNode: ComponentContent<object> =
              new ComponentContent(this.getUIContext(), wrapBuilder(editCategoryDialog),
                new EditCategoryParam(this.isEditCategoryName,
                  this.categoryService.getCategoryById(this.categoryId), this.scroller, this.kvStore!, this.uiContext));
            DialogUtil.openDialog(this.getUIContext(), contentNode);
          });
        }
        .width('100%')
        .padding({
          left: $r('sys.float.padding_level8'),
          right: $r('sys.float.padding_level8'),
          top: 10,
          bottom: 50,
        })

      }
      .scrollBar(BarState.Off)
    }
    .backgroundColor($r('sys.color.background_secondary'))
    .onReady((cxt: NavDestinationContext) => {
      this.categoryList = this.categoryService.getCategoryList();
      let params = cxt.pathInfo.param as Record<string, Object>;
      this.isEditCategory = params.isEditCategory as boolean;
      this.currentCategory = params.currentCategory as Category;
      if (!this.isEditCategory) {
        this.noteList = params.noteList as Note[];
      }
    })
    .title('笔记分类')
    .onBackPressed(() => {
      this.appPathStack.pop();
      return true;
    })
  }

  /** 普通分类视图（过滤掉"全部笔记"，供 List 多列布局渲染）。 */
  get normalCategories(): Array<Category> {
    return this.categoryList.filter((c: Category): boolean => c.id !== '-1');
  }

  partOfNoteList(categoryId: string): boolean {
    if (this.noteList) {
      return this.noteList.find(item => item.categoryId === categoryId) ? true : false;
    }
    return false;
  }
}

class EditCategoryParam {
  isEdit: boolean;
  category: Category | undefined
  scroller: ListScroller
  kvStore: KVStore
  uiContext: UIContext

  constructor(isEdit: boolean, category: Category | undefined, scroller: ListScroller, kvStore: KVStore,
    uiContext: UIContext) {
    this.isEdit = isEdit;
    this.category = category;
    this.scroller = scroller
    this.kvStore = kvStore
    this.uiContext = uiContext
  }
}

@Builder
function editCategoryDialog(params: EditCategoryParam) {
  EditCategoryDialog({
    params: params
  })
}

@ComponentV2
struct EditCategoryDialog {
  @Param @Require params: EditCategoryParam;
  @Local newName: string = '';
  categoryService: CategoryService = CategoryService.instance;

  build() {
    Column() {
      Text(this.params.isEdit ? '重命名' : '新建分类')
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .padding({
          top: 11,
          bottom: 12,
        });

      TextInput({
        text: this.params.isEdit ? this.params.category?.name : '',
      })
        .height(48)
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .borderRadius(16)
        .margin({
          left: '3%',
          right: '3%',
        })
        .onChange((value) => {
          this.newName = value;
        });

      Row() {
        Row() {
          Text('取消')
            .editCategoryButtonStyle();
        }
        .justifyContent(FlexAlign.Center)
        .height(70)
        .width('50%')
        .onClick(() => {
          DialogUtil.closeDialog();
        });

        Row() {
          Text('确定')
            .editCategoryButtonStyle();
        }
        .justifyContent(FlexAlign.Center)
        .height(70)
        .width('50%')
        .onClick(() => {
          if (StringUtil.isBlank(this.newName)) {
            this.getUIContext().getPromptAction().showToast({
              message: '分类名称为空, 请重新填写 ~',
              duration: 1500,
              alignment: Alignment.Center,
            });
            return;
          }

          this.params.scroller.closeAllSwipeActions()
          if (this.params.isEdit) {
            if (this.params.category) {
              this.params.category.name = this.newName;
              this.categoryService.updateCategory(this.params.category, this.params.kvStore)
            }
            DialogUtil.closeDialog();
            return;
          }
          if (this.categoryService.addCategory(new Category(this.newName, 0), this.params.kvStore,
            this.params.uiContext)) {
            DialogUtil.closeDialog();
          }
        });
      };
    }
    .borderRadius(16)
    .backgroundColor($r('sys.color.comp_background_list_card'))
    .width('92%')
    .height(158);
  }
}


class DeleteCategoryParam {
  categoryId: string
  scroller: ListScroller
  kvStore: KVStore
  uiContext: UIContext

  constructor(categoryId: string, scroller: ListScroller, kvStore: KVStore, uiContext: UIContext) {
    this.categoryId = categoryId;
    this.scroller = scroller
    this.kvStore = kvStore
    this.uiContext = uiContext
  }
}

@Builder
function deleteCategoryDialog(params: DeleteCategoryParam) {
  DeleteCategoryDialog({
    params: params
  })
}

@ComponentV2
struct DeleteCategoryDialog {
  @Param @Require params: DeleteCategoryParam;
  noteService: NoteService = NoteService.instance;
  categoryService: CategoryService = CategoryService.instance;

  build() {
    Column({ space: 30 }) {
      Row() {
        Text('仅删除分类')
          .fontSize(16)
          .onClick(() => {
            this.noteService.moveNotesCategory(this.params.categoryId, this.params.kvStore, this.params.uiContext);
            this.categoryService.deleteCategoryById(this.params.categoryId, this.params.kvStore);

            this.getUIContext().getPromptAction().showToast({
              message: '删除成功 ~',
              alignment: Alignment.Center,
              duration: 1500,
            });
            this.params.scroller.closeAllSwipeActions();
            DialogUtil.closeDialog();
          });
      }
      .justifyContent(FlexAlign.Center)
      .width('100%')
      .height(20);

      Row() {
        Text('删除分类和笔记')
          .fontSize(16)
          .fontColor(Color.Red)
          .onClick(() => {
            // 删除笔记
            let notes = this.noteService.getNoteList(this.params.categoryId);
            notes.forEach((item) => {
              this.noteService.deleteNoteToTrash(item.id, item.categoryId, this.params.kvStore, this.params.uiContext);
            });
            // 删除分类
            this.categoryService.deleteCategoryById(this.params.categoryId, this.params.kvStore);
            this.getUIContext().getPromptAction().showToast({
              message: '删除成功 ~',
              alignment: Alignment.Center,
              duration: 1500,
            });
            this.params.scroller.closeAllSwipeActions();
            DialogUtil.closeDialog();
          });
      }
      .justifyContent(FlexAlign.Center)
      .width('100%')
      .height(20);

      Row() {
        Text('取消')
          .fontSize(16)
          .fontColor(Color.Grey)
          .onClick(() => {
            DialogUtil.closeDialog()
          });
      }
      .justifyContent(FlexAlign.Center)
      .width('100%')
      .height(20);
    }
    .backgroundColor($r('sys.color.comp_background_list_card'))
    .width('92%')
    .borderRadius(16)
    .padding({
      top: 30,
      bottom: 30,
    });
  }
}


@Extend(Text)
function editCategoryButtonStyle() {
  .fontSize(16)
  .fontColor('#0A59F7')
  .fontWeight(FontWeight.Medium);
}
