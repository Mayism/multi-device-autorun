import { Category } from './Model';
import { hilog } from '@kit.PerformanceAnalysisKit';

export function initCategoryList(): Array<Category>{
  let categoryList: Array<Category> = [];
  categoryList.push(new Category('全部笔记', 0, '-1',));
  hilog.info(0x0000, `Date`, `initCategoryList success.`)
  return categoryList;
}


