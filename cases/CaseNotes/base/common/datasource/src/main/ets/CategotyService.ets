import { initCategoryList } from './Data';
import { Category } from './Model';
import { KVStore, SerializeUtil } from 'serializer';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Note } from 'richeditor';

@ObservedV2
export class CategoryService {
  logTag: string = '[CategoryService]';
  domainId: number = 0x0000;
  private static _instance: CategoryService;

  public static get instance() {
    if (!CategoryService._instance) {
      CategoryService._instance = new CategoryService();
    }
    return CategoryService._instance;
  }

  /**
   * 初始化分类数据
   */
  @Trace private categoryList: Array<Category> = initCategoryList();

  public loadCategoryList(kvStore: KVStore, notes: Array<Note>) {
    kvStore.getAll('Category_').then(async (dataList) => {
      const promises = dataList?.map(async data => {
        const category = JSON.parse(data.value as string) as Category;
        this.categoryList.push(category);
        hilog.info(this.domainId, this.logTag, `Load category ${category.id} success.`);
      }) || [];
      await Promise.all(promises);
      hilog.info(this.domainId, this.logTag, `Load category success.`);

      this.resetTotalCount(notes);
    });
  }

  private resetTotalCount(notes: Array<Note>) {
    this.categoryList.forEach(category => {
      category.totalCount = 0;
    });
    const defaultCategory = this.categoryList.find(category => category.id === '-1');
    defaultCategory!.totalCount = notes.length;
    notes.filter(note => note.categoryId !== '-1').forEach(note => {
      const matchedCategory = this.categoryList.find(category => category.id === note.categoryId);
      if (matchedCategory) {
        matchedCategory.totalCount += 1;
        hilog.info(this.domainId, this.logTag,
          `Increment totalCount for category ${matchedCategory.id}, new count: ${matchedCategory.totalCount}`);
      }
    });
  }

  /**
   * 获取所有分类列表
   * @returns 所有分类列表
   */
  getCategoryList(): Array<Category> {
    return this.categoryList;
  }

  /**
   * 获取所有分类列表
   * @returns 所有分类列表
   */
  getCategoryById(id: string): Category | undefined {
    return this.categoryList.find((item) => item.id === id);
  }

  getFirstCategory(): Category {
    return this.categoryList[0];
  }

  /**
   * 增加分类
   * @param category 待新增的分类
   */
  addCategory(category: Category, kvStore: KVStore, uiContext: UIContext): boolean {
    let sameNameCategory = this.categoryList.find((item) => item.name === category.name);
    if (sameNameCategory) {
      uiContext.getPromptAction().showToast({
        message: '已存在相同名称的分类，请重新创建 ~',
        duration: 1500,
        alignment: Alignment.Center,
      });
      return false;
    }
    this.categoryList.push(category);

    kvStore.put('Category_' + category.id, JSON.stringify(category).replace(/__ob_/g, ''));
    return true;
  }

  /**
   * 更新分类
   * @param category
   * @param kvStore
   */
  updateCategory(category: Category, kvStore: KVStore) {
    let target = this.categoryList.find((item) => item.id === category.id);
    target!.name = category.name;
    kvStore.put('Category_' + category.id, JSON.stringify(category).replace(/__ob_/g, ''));
  }

  /**
   * 删除分类id指定位置的分类
   * @param index 索引位置
   */
  deleteCategoryById(categoryId: string, kvStore?: KVStore): void {
    let index = this.categoryList.findIndex((item) => item.id === categoryId);
    this.categoryList.splice(index, 1);

    kvStore?.delete('Category_' + categoryId);
  }

  /**
   * 移动分类
   * @param originalCategoryId 源分类Id
   * @param targetCategoryId 目标分类Id
   */
  moveCategory(note: Note, targetCategoryId: string, kvStore: KVStore, uiContext: UIContext) {
    let originalCategoryId = note.categoryId;
    if (originalCategoryId === targetCategoryId) {
      return;
    }

    if (originalCategoryId !== '-1') {
      let originalCategory = this.getCategoryById(originalCategoryId);
      if (originalCategory) {
        originalCategory.totalCount--;
        kvStore?.put('Category_' + originalCategory.id, JSON.stringify(originalCategory).replace(/__ob_/g, ''));
      }
    }


    let targetCategory = this.getCategoryById(targetCategoryId);
    if (targetCategory) {
      if (targetCategory.id !== '-1') {
        targetCategory.totalCount++;

        kvStore?.put('Category_' + targetCategory.id, JSON.stringify(targetCategory).replace(/__ob_/g, ''));
      }
    }
    putNoteInKvStore(note, uiContext, kvStore, 'EffectiveNote');
  }
}

/**
 * 持久化 保存笔记
 * @param note
 * @param uiContext
 * @param kvStore
 * @param prefix
 */
function putNoteInKvStore(note: Note, uiContext: UIContext, kvStore: KVStore, prefix: string) {
  SerializeUtil.serialize(note.styledString, uiContext).then(value => {
    let key = prefix + '_' + note.id;
    note.serializedStyledString = value;
    kvStore.put(key, JSON.stringify(note).replace(/__ob_/g, ''));
  });
}