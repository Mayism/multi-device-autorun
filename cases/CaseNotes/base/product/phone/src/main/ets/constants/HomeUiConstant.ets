import { SortEnum } from '@ohos_agcit/notes_datasource'

export enum TOOL_BAR_NAME {
  move_category = '移动到分类',
  delete = '删除',
  select_all = '全选'
}

export interface ToolBar {
  name: TOOL_BAR_NAME,
  icon: Resource
}

export const toolBarList:ToolBar[] = [
  {
    name: TOOL_BAR_NAME.move_category,
    icon: $r('app.media.move_category')
  },
  {
    name: TOOL_BAR_NAME.delete,
    icon: $r('app.media.delete')
  },
  {
    name: TOOL_BAR_NAME.select_all,
    icon: $r('app.media.select_all')
  }
]



export interface  SortType {
  name: string | Resource;
  type: SortEnum
}

export const sortData:SortType[] = [
  {
    name:$r('app.string.sort_by_create_time'),
    type: SortEnum.CREATE_TIME
  },
  {
    name:$r('app.string.sort_by_update_time'),
    type: SortEnum.UPDATE_TIME
  }
]

export enum SHOW_METHOD_ENUM {
  waterFlowList = '1',  // 瀑布流方式展示
  normalList = '2'      // 常规列表
}

export interface  ShowMethod {
  name: string | Resource;
  type: SHOW_METHOD_ENUM
}

export const showType: ShowMethod[] = [
  {
    name:$r('app.string.show_by_card'),
    type: SHOW_METHOD_ENUM.waterFlowList
  },
  {
    name:$r('app.string.show_by_list'),
    type: SHOW_METHOD_ENUM.normalList
  }
]

