/**
 * 我的页面-各种服务信息
 */
export interface MinePageCommonService{
  /**
   * 图标
   */
  icon: string,
  /**
   * 标签名称
   */
  label: string,
  /**
   * 跳转到下一页
   */
  nextPage?: string
}

export const COMMON_SERVICE: Array<MinePageCommonService> = [
  {
    icon: 'app.media.trash',
    label: '回收站',
    nextPage: 'Trash'
  },
  {
    icon: 'app.media.setting',
    label: '设置',
    nextPage: 'Setting'
  },
  {
    icon: 'app.media.feed_back',
    label: '意见反馈',
    nextPage: 'FeedBackChoose'
  }
]