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
import { Category, CategoryService, NoteService, SortEnum, seedMockData } from '@ohos_agcit/notes_datasource';
import { DateConstants, DateUtil } from '@ohos_agcit/notes_utils';
import { AppStorageV2, PersistenceV2 } from '@kit.ArkUI';
import { SecretLock } from 'secretlock';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SortController } from '../controller/SortController';
import { NoteSearchController } from '../controller/NoteSearchController';
import { CategoryController } from '../controller/CategoryController';
import { SearchNoResult } from '../components/SearchNoResult';
import { EmptyNotes } from '../components/EmptyNotes';
import { JSON } from '@kit.ArkTS';
import { SelectedController } from '../controller/SelectedController';
import { LazyDataSource, Note } from 'richeditor';
import {
  SHOW_METHOD_ENUM,
  ShowMethod,
  showType,
  sortData,
  SortType,
  TOOL_BAR_NAME,
  ToolBar,
  toolBarList,
} from '../constants/HomeUiConstant';
import { SettingController } from '../controller/SettingController';
import { KVStore, SerializeUtil } from 'serializer';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { distributedKVStore } from '@kit.ArkData';
import { ContinueModel, ContinueUtils } from 'continue';
import { UserInfo } from 'login';

@Entry
@ComponentV2
struct Index {
  logTag: string = '[Index]';
  domainId: number = 0x0000;
  @Provider('appPathStack') appPathStack: NavPathStack = new NavPathStack();
  @Local continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;
  noteService: NoteService = NoteService.instance;
  categoryService: CategoryService = CategoryService.instance;
  sortController: SortController = SortController.instance;
  noteSearchController: NoteSearchController = NoteSearchController.instance;
  categoryController: CategoryController = CategoryController.instance;
  selectedController: SelectedController = SelectedController.instance;
  settingController: SettingController = SettingController.instance;
  uiContext: UIContext = this.getUIContext() as UIContext;
  hostContext: common.Context = this.uiContext.getHostContext() as Context;
  @Provider() kvStore: KVStore | undefined = undefined;
  securityLevel: distributedKVStore.SecurityLevel = distributedKVStore.SecurityLevel.S1;
  @Local secretLock: SecretLock = PersistenceV2.connect(SecretLock, () => new SecretLock())!;
  @Local hasShownSplashAd: boolean = false;
  private userInfo: UserInfo = UserInfo.instance;
  @Local noteList: Note[] = [];
  @Local currentCategory: Category = this.categoryService.getFirstCategory();
  @Local dataList: LazyDataSource<Note> = new LazyDataSource();
  @Local showListType: SHOW_METHOD_ENUM = SHOW_METHOD_ENUM.normalList;
  private gestureShareCheckTimerId: number = -1;

  async aboutToAppear() {
    // 创建KV数据库
    this.kvStore = new KVStore();
    try {
      this.kvStore.kvStore = await this.kvStore.createKVStore(false, this.securityLevel, this.uiContext);
    } catch (e) {
      const err = e as BusinessError;
      hilog.error(0x0000, 'Index', `createKVStore failed: ${err.code} ${err.message}`);
    }

    // 预填 mock 数据（每次启动重建，先清后写保证幂等），需在 load 之前完成
    await seedMockData(this.kvStore, this.uiContext);

    // 读取持久化数据，加载完成后刷新首页 noteList
    this.noteService.loadEffectiveNote(this.kvStore, this.hostContext, () => {
      this.noteList = this.noteService.getNoteList(
        this.currentCategory.id, this.sortController.sortBy, this.noteSearchController.searchKeyword);
      this.updateDataList();
    });
    this.noteService.loadDeleteNote(this.kvStore);
    this.categoryService.loadCategoryList(this.kvStore, this.noteList);

    // 检查接续场景
    this.checkAndHandleContinueScene();
    // 检查隔空传送（传内容 / 仅链接）：立即检查 + 短时轮询（热启动时 payload 在 onNewWant 里设置，Index 已加载不会再次 aboutToAppear）
    this.checkAndHandleGestureShare();
    this.gestureShareCheckTimerId = setInterval(() => this.checkAndHandleGestureShare(), 800);
  }

  /**
   * 打开笔记编辑页：手机端统一走 Navigation 栈。
   */
  private openEditNotesPage(params: Record<string, Object>): void {
    this.appPathStack.pushPathByName('EditNotes', params);
  }

  aboutToDisappear(): void {
    if (this.gestureShareCheckTimerId >= 0) {
      clearInterval(this.gestureShareCheckTimerId);
      this.gestureShareCheckTimerId = -1;
    }
  }

  /**
   * 检查并处理隔空传送：传内容则新建笔记并打开，仅链接则按 noteId 打开
   */
  private checkAndHandleGestureShare(): void {
    const fromContent: boolean | undefined = AppStorage.get<boolean>('from_gesture_share_content');
    const payload: Record<string, Object> | undefined = AppStorage.get<Record<string, Object>>('shared_note_payload');
    if (fromContent === true && payload) {
      AppStorage.setOrCreate('from_gesture_share_content', false);
      AppStorage.delete('shared_note_payload');
      if (this.gestureShareCheckTimerId >= 0) {
        clearInterval(this.gestureShareCheckTimerId);
        this.gestureShareCheckTimerId = -1;
      }
      this.createNoteFromSharePayload(payload);
      return;
    }
    const fromLink: boolean | undefined = AppStorage.get<boolean>('from_gesture_share');
    const noteId: string | undefined = AppStorage.get<string>('share_note_id');
    if (fromLink === true && noteId) {
      AppStorage.setOrCreate('from_gesture_share', false);
      AppStorage.delete('share_note_id');
      const note = this.noteService.getNoteById(noteId);
      if (note) {
        setTimeout(() => {
          const params: Record<string, Object> = {
            'noteId': noteId,
            'currentCategory': this.categoryService.getCategoryById(note.categoryId) ||
            this.categoryService.getFirstCategory(),
          };
          this.openEditNotesPage(params);
        }, 300);
      } else {
        this.showToast('未找到该笔记，可能尚未同步到本机');
      }
    }
  }

  /**
   * 用隔空传送的 payload 新建笔记并跳转编辑页
   */
  private createNoteFromSharePayload(payload: Record<string, Object>): void {
    const serializedStyledString = payload.serializedStyledString as string;
    if (!serializedStyledString) {
      this.showToast('分享数据不完整');
      return;
    }
    SerializeUtil.deserialize(serializedStyledString).then((mss: MutableStyledString) => {
      const note = new Note(mss);
      note.title = (payload.title as string) || '我的笔记';
      const rawCategoryId = (payload.categoryId as string) || '-1';
      note.categoryId = this.categoryService.getCategoryById(rawCategoryId) ? rawCategoryId : '-1';
      note.description = (payload.description as string) || '';
      note.createTime = (payload.createTime as string) || String(Date.now());
      note.updateTime = (payload.updateTime as string) || note.createTime;
      note.serializedStyledString = serializedStyledString;
      this.noteService.addNote(note, this.kvStore, this.uiContext, true);
      this.noteList = this.noteService.getNoteList(
        this.currentCategory.id, this.sortController.sortBy, this.noteSearchController.searchKeyword);
      this.updateDataList();
      const category = this.categoryService.getCategoryById(note.categoryId) ||
      this.categoryService.getFirstCategory();
      setTimeout(() => {
        const params: Record<string, Object> = {
          'noteId': note.id,
          'currentCategory': category,
        };
        this.openEditNotesPage(params);
        this.showToast('已接收隔空传送的笔记');
      }, 300);
    }).catch((err: Error) => {
      hilog.error(this.domainId, this.logTag, `隔空传送反序列化失败: ${err.message}`);
      this.showToast('笔记内容解析失败');
    });
  }

  /**
   * 检查并处理接续场景
   */
  private async checkAndHandleContinueScene(): Promise<void> {
    if (!ContinueUtils.isContinueScene()) {
      return;
    }

    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;

    if (!continueModel.noteId) {
      return;
    }

    // 验证笔记是否存在
    const note = this.noteService.getNoteById(continueModel.noteId);
    if (!note) {
      this.showToast('接续的笔记不存在');
      ContinueUtils.clearContinueFlag();
      return;
    }

    // 直接跳转到编辑页面
    await new Promise<void>(resolve => setTimeout(resolve, 300));

    const params: Record<string, Object> = {
      'noteId': continueModel.noteId,
      'currentCategory': this.categoryService.getCategoryById(note.categoryId) ||
      this.categoryService.getFirstCategory(),
    };

    this.openEditNotesPage(params);

    hilog.info(this.domainId, this.logTag,
      `接续跳转到编辑页面: noteId=${continueModel.noteId}, title=${continueModel.noteTitle}`);
  }

  /**
   * 显示提示
   */
  private showToast(message: string): void {
    this.getUIContext().getPromptAction().showToast({
      message: message,
      alignment: Alignment.Center,
      duration: 2000,
    });
  }

  // 更新瀑布流卡片数据
  updateDataList() {
    this.dataList.clear();
    this.noteList.forEach((item: Note) => {
      this.dataList.pushData(item);
    });
  }

  // 笔记卡片长按事件
  handleLangPress(item: Note) {
    // 非多选状态下生效
    if (!this.selectedController.isCtrl) {
      this.selectedController.isCtrl = true;
      item.isSelected = true;
      this.selectedController.selectedCount = 1;
    }
  }

  getSelectedImage(isSelect: boolean): ResourceStr {
    return isSelect ? $r('app.media.selected') : $r('app.media.unselected');
  }

  getNoteItemBgColor(isSelect: boolean): ResourceStr {
    if (this.selectedController.isCtrl) {
      return isSelect ? $r('sys.color.background_tertiary') : $r('sys.color.comp_background_list_card');
    }
    return $r('sys.color.comp_background_list_card');
  }

  // 获取选中的笔记
  getSelectData(): Note[] {
    let tempArray: Note[] = [];
    this.noteList.forEach((item) => {
      if (item.isSelected) {
        tempArray.push(item);
      }
    });
    if (tempArray.length === 0) {
      this.getUIContext().getPromptAction().showToast({
        message: '还未选中任何笔记',
        alignment: Alignment.Center,
      });
    }
    return tempArray;
  }

  // 全选
  handleSelectAll() {
    if (this.selectedController.selectedCount === this.noteList.length) {
      this.noteList.forEach(item => item.isSelected = false);
      this.selectedController.selectedCount = 0;
    } else {
      this.noteList.forEach(item => item.isSelected = true);
      this.selectedController.selectedCount = this.noteList.length;
    }
  }

  // 底部工具栏点击事件 分类、删除、全选
  handleToolBarClick(name: TOOL_BAR_NAME) {
    if (name === TOOL_BAR_NAME.select_all) {
      this.handleSelectAll();
      return;
    }

    const selectDataList = this.getSelectData();
    if (selectDataList.length === 0) {
      return;
    }

    if (name === TOOL_BAR_NAME.move_category) {
      const params: Record<string, Object> =
        { 'isEditCategory': false, 'currentCategory': this.currentCategory, 'noteList': selectDataList };
      this.appPathStack.pushPathByName('EditCategory', params);
      return;
    }

    if (name === TOOL_BAR_NAME.delete) {
      const params: Record<string, Object> = { 'noteList': selectDataList };
      this.appPathStack.pushPathByName('DeleteNoteDialog', params);
    }
  }

  // 重置分类
  resetCategory(category: Category) {
    this.currentCategory = category;
    this.noteSearchController.isSearching = false; // 重置搜索状态
    this.noteSearchController.searchKeyword = '';
    this.noteList = this.noteService.getNoteList(
      this.currentCategory.id, this.sortController.sortBy, this.noteSearchController.searchKeyword);
    this.categoryController.openCategorySheet = false;
    this.updateDataList();
  }

  // 列表排序
  sort = (type: SortEnum) => {
    this.sortController.onSortConfirm(this.currentCategory.id, type,
      this.noteSearchController.searchKeyword);
  };
  // 列表展示方式
  toggleShowType = (useWaterFlow: SHOW_METHOD_ENUM) => {
    this.showListType = useWaterFlow;
    if (this.showListType === SHOW_METHOD_ENUM.waterFlowList) {
      this.updateDataList();
    }
    this.sortController.openSortSheet = false;
  };

  @Builder
  addNoteBuilder() {
    if (this.selectedController.isCtrl === false) {
      Row() {
        SymbolGlyph($r('sys.symbol.plus'))
          .fontColor([Color.White])
          .fontSize(35);
      }
      .justifyContent(FlexAlign.Center)
      .width(50)
      .height(50)
      .borderRadius(44)
      .backgroundColor('#FFAA00')
      .zIndex(10)
      .position({
        right: 32,
        bottom: 100,
      })
      .onClick(() => {
        const params: Record<string, Object> = { 'noteId': '', 'currentCategory': this.currentCategory };
        this.openEditNotesPage(params);
      });
    }
  }

  @Builder
  toolBarBuilder() {
    if (this.selectedController.isCtrl) {
      Row() {
        ForEach(toolBarList, (item: ToolBar) => {
          Column({ space: 5 }) {
            Image(item.icon)
              .width(24)
              .height(24);

            Text(item.name)
              .fontSize(10)
              .fontColor($r('sys.color.font_secondary'));
          }
          .onClick(() => {
            this.handleToolBarClick(item.name);
          });
        }, (item: ToolBar) => {
          try {
            return JSON.stringify(item);
          } catch (error) {
            hilog.error(this.domainId, this.logTag, 'ToolBar key stringify error');
            return item.name;
          }
        });
      }
      .margin({ top: 10 })
      .padding({ bottom: 10 })
      .justifyContent(FlexAlign.SpaceAround)
      .width('100%')
      .height(70)
      .backgroundColor($r('sys.color.comp_background_list_card'));
    }
  }

  @Styles
  topAreaStyle() {
    .width('100%')
    .padding({
      top: 12,
      bottom: 20,
      left: $r('sys.float.padding_level8'),
      right: $r('sys.float.padding_level8'),
    });
  }

  @Builder
  topArea() {
    Row() {
      Text(this.selectedController.isCtrl ? `已选${this.selectedController.selectedCount}项` :
        $r('app.string.homepage'))
        .fontSize(24)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.font_primary'));
      Blank();
      Image(this.selectedController.isCtrl ? $r('app.media.exit_ctrl') : $r('app.media.user_avatar'))
        .width(this.selectedController.isCtrl ? 24 : 40)
        .height(this.selectedController.isCtrl ? 24 : 40)
        .onClick(() => {
          if (this.selectedController.isCtrl) {
            this.noteList.forEach(item => item.isSelected = false);
            this.selectedController.recoverInitState();
          } else {
            this.appPathStack.pushPathByName('MineView', undefined);
          }
        });
    }
    .topAreaStyle();
  }

  @Builder
  editorNoteList() {
    if (!this.selectedController.isCtrl) {
      Row() {
        Row({ space: 4 }) {
          Text(this.currentCategory.name)
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.font_primary'));

          SymbolGlyph($r('sys.symbol.arrowtriangle_down_fill'))
            .fontColor([$r('sys.color.font_secondary')]);
        }.onClick(() => {
          this.categoryController.openCategorySheet = true;
        })
        .id('category_trigger')
        .bindSheet($$this.categoryController.openCategorySheet, this.showCategoryDialog(), {
          title: { title: $r('app.string.note_category') },
          width: '100%',
          height: 400,
          radius: {
            topLeft: 32,
            topRight: 32,
            bottomLeft: 32,
            bottomRight: 32,
          },
        });

        Blank();
        Image($r('app.media.icon_more'))
          .height(20)
          .width(20)
          .onClick(() => {
            this.sortController.openSortSheet = true;
          })
          .bindSheet($$this.sortController.openSortSheet, this.sortSheet(), {
            width: '100%',
            showClose: true,
            height: 376,
            radius: {
              topLeft: 32,
              topRight: 32,
              bottomLeft: 32,
              bottomRight: 32,
            },
          });
      }
      .width('100%')
      .padding({
        left: $r('sys.float.padding_level8'),
        right: $r('sys.float.padding_level8'),
        top: 12,
        bottom: 12,
      });
    }
  }

  @Builder
  cardItem(item: Note, maxLines: number) {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column({ space: 12 }) {
        Text(item.title)
          .fontSize(18)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.font_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });

        Text(item.description)
          .maxLines(maxLines)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize(14)
          .lineHeight(19)
          .fontColor($r('sys.color.font_secondary'))
          .fontWeight(FontWeight.Regular);

        Text(DateUtil.getFormatDateStr(item.createTime, DateConstants.DATE_FORMAT4))
          .fontSize(12)
          .fontColor($r('sys.color.font_tertiary'));
      }
      .alignItems(HorizontalAlign.Start)
      .backgroundColor(this.getNoteItemBgColor(item.isSelected))
      .borderRadius(16)
      .width('100%')
      .padding(12);

      if (this.selectedController.isCtrl) {
        Image(this.getSelectedImage(item.isSelected))
          .width(35)
          .height(35)
          .padding({ top: 10, right: 10 });
      }
    }
    .onClick(() => {
      if (this.selectedController.isCtrl) {
        item.isSelected = !item.isSelected;
        let count: number = 0;
        this.noteList.forEach(item => {
          if (item.isSelected) {
            count++;
          }
        });
        this.selectedController.selectedCount = count;
      } else {
        // 进入编辑器
        const params: Record<string, Object> = { 'noteId': item.id, 'currentCategory': this.currentCategory };
        this.appPathStack.pushPathByName('EditNotes', params);
      }
    });
  }

  @Styles
  cardWrapperStyle() {
    .width('100%')
    .margin({ bottom: 10 })
    .padding({
      left: $r('sys.float.padding_level8'),
      right: $r('sys.float.padding_level8'),
    })
    .layoutWeight(1);
  }

  @Builder
  cardList() {
    Column() {
      List({ space: 12 }) {
        ForEach(this.noteList, (item: Note) => {
          ListItem() {
            this.cardItem(item, 1);
          }
          .gesture(
            // 绑定可以重复触发的LongPressGesture
            LongPressGesture({ repeat: false, fingers: 1, duration: 500 })
              .onAction((event: GestureEvent | undefined) => {
                if (event) {
                  this.handleLangPress(item);
                }
              }),
          );
        }, (item: Note) => item.id);
      }
      .id('note_list')
      // “按列表展示”统一为单列
      .lanes(1, 0)
      .scrollBar(BarState.Off);
    }
    .cardWrapperStyle();
  }

  @Builder
  waterCardList() {
    Column() {
      WaterFlow() {
        LazyForEach(this.dataList, (item: Note, index: number) => {
          FlowItem() {
            this.cardItem(item, 9);
          }
          .onAppear(() => {
            if (index === this.dataList.totalCount()) {
              this.updateDataList();
            }
          })
          .width('100%')
          .gesture(
            // 绑定可以重复触发的LongPressGesture
            LongPressGesture({ repeat: false, fingers: 1, duration: 500 })
              .onAction((event: GestureEvent | undefined) => {
                if (event) {
                  this.handleLangPress(item);
                }
              }),
          );
        }, (item: Note) => item.id);
      }
      .cachedCount(1)
      .columnsTemplate('1fr 1fr')
      .columnsGap($r('sys.float.padding_level8'))
      .rowsGap(16)
      .width('100%')
      .height('100%');
    }
    .cardWrapperStyle();
  }

  @Builder
  showNoteList() {
    if (this.noteSearchController.isSearching && this.noteList.length === 0) {
      SearchNoResult();
    }
    if (!this.noteSearchController.isSearching && this.noteList.length === 0) {
      EmptyNotes();
    } else if (this.showListType === SHOW_METHOD_ENUM.normalList) {
      this.cardList();
    } else {
      this.waterCardList();
    }
  }

  @Builder
  showCategoryDialog() {
    Column() {
      Column() {
        List() {
          ForEach(this.categoryService.getCategoryList(), (category: Category, index: number) => {
            ListItem() {
              Column() {
                if (index !== 0) {
                  Divider()
                    .color($r('sys.color.comp_divider'));
                }
                Row() {
                  Text(category.name)
                    .fontSize(16)
                    .fontColor(this.currentCategory.id === category.id ?
                      $r('sys.color.font_primary') : $r('sys.color.font_secondary'))
                    .fontWeight(this.currentCategory?.id === category.id ? FontWeight.Medium : FontWeight.Regular);

                  Blank();
                  Text(String(category.totalCount))
                    .fontSize(16);
                }
                .width('100%')
                .height(50);
              };
            }
            .backgroundColor($r('sys.color.comp_background_list_card'))
            .padding({
              left: 12,
              right: 12,
            })
            .onClick(() => {
              this.resetCategory(category);
            });
          }, (category: Category) => category.id);
        }
        .borderRadius(8)
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.None);
      }
      .height(250);

      Button() {
        Row() {
          Text($r('app.string.go_note_category'))
            .fontSize($r('sys.float.Body_L'))
            .fontColor($r('sys.color.font_on_primary'))
            .fontWeight(FontWeight.Medium);
          SymbolGlyph($r('sys.symbol.chevron_right'))
            .fontWeight(FontWeight.Medium)
            .fontSize(18)
            .fontColor([Color.White])
            .padding({
              left: 13,
            });
        };
      }
      .height(40)
      .width('100%')
      .backgroundColor('#FFAA00')
      .margin({
        bottom: 30,
      })
      .onClick(() => {
        this.categoryController.openCategorySheet = false;
        if (this.currentCategory) {
          const params: Record<string, Object | undefined> =
            { 'isEditCategory': true, 'currentCategory': this.currentCategory, 'noteList': undefined };
          this.appPathStack.pushPathByName('EditCategory', params);
        }
      });
    }
    // 内容区域占满 sheet，避免百分比二次缩放导致列表区域被挤没
    .width('100%')
    .height('100%')
    .padding({
      left: $r('sys.float.padding_level8'),
      right: $r('sys.float.padding_level8'),
    })
    .backgroundColor($r('sys.color.background_secondary'));
  }

  @Builder
  sheetCard(title: string, data: SortType[] | ShowMethod[], callBack: Function, group: string) {
    Column() {
      Text(title)
        .fontSize(20)
        .fontWeight(FontWeight.Medium)
        .width('100%')
        .textAlign(TextAlign.Start)
        .margin({ bottom: 16 });

      List({ space: 24 }) {
        ForEach(data, (item: SortType | ShowMethod) => {
          ListItem() {
            Row() {
              Text(item.name)
                .fontSize(16)
                .fontColor($r('sys.color.font_primary'));
              Blank();
              Radio({ value: item.type, group: group })
                .checked(group === 'showType' ? this.showListType === item.type :
                  this.sortController.sortBy === item.type)
                .onChange((isChecked: boolean) => {
                  if (isChecked === true) {
                    callBack(item.type);
                  }
                });
            }
            .width('100%')
            .padding({ left: 12, right: 12 })
            .onClick(() => callBack(item.type));
          };
        }, (item: SortType) => {
          try {
            return JSON.stringify(item);
          } catch (error) {
            hilog.error(this.domainId, this.logTag, 'SortType key stringify error');
            return item.type;
          }
        });
      }
      .backgroundColor($r('sys.color.comp_background_list_card'))
      .borderRadius(8)
      .padding({
        top: 16,
        bottom: 16,
      })
      .divider({
        strokeWidth: 1,
        startMargin: 12,
        endMargin: 12,
      });
    }
    .backgroundColor($r('sys.color.background_secondary'))
    .width('100%')
    .padding({
      top: 20,
      left: $r('sys.float.padding_level8'),
      right: $r('sys.float.padding_level8'),
    });
  }

  @Builder
  sortSheet() {
    Column() {
      this.sheetCard('展示形式', showType, this.toggleShowType, 'showType');
      this.sheetCard('排序方式', sortData, this.sort, 'sortGroup');
    };
  }

  build() {
    Navigation(this.appPathStack) {
      Column() {
        this.topArea();
        Search({
          placeholder: $r('app.string.search_note'),
        })
          .placeholderFont({ size: $r('sys.float.Body_L') })
          .placeholderColor($r('sys.color.font_secondary'))
          .fontColor($r('sys.color.font_primary'))
          .margin({
            bottom: 12,
            left: $r('sys.float.padding_level8'),
            right: $r('sys.float.padding_level8'),
          })
          .onSubmit((value: string) => { // 提交搜索
            this.noteList = this.noteSearchController.onSearch(this.currentCategory.id, value,
              this.sortController.sortBy);
            this.updateDataList();
          })
          .onChange((value: string) => { // 输入变化时
            if (!value) {
              // 清空搜索时恢复列表
              this.noteList =
                this.noteSearchController.onSearch(this.currentCategory.id, '', this.sortController.sortBy);
              this.updateDataList();
            }
          });

        // 上方工具栏
        this.editorNoteList();

        // 卡片列表
        this.showNoteList();

        // 多选底部工具栏
        this.toolBarBuilder();

        // 新增笔记
        this.addNoteBuilder();
      }
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM, SafeAreaEdge.TOP])
      .backgroundColor($r('sys.color.background_secondary'))
      .width('100%')
      .height('100%');
    }
    .hideTitleBar(true)
    .mode(NavigationMode.Stack);
  }
}
