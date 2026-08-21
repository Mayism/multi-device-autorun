export interface MoreFunction {
  icon: ResourceStr,
  name: ResourceStr
}

export enum ACTION_NAME {
  share = '分享',
  copy = '复制'
}


export const MORE_ACTION_LIST: Array<MoreFunction> = [
  {
    icon: $r('app.media.share'),
    name: ACTION_NAME.share
  },
  {
    icon: $r('app.media.copy'),
    name: ACTION_NAME.copy
  }
]