import { showToast } from 'vant'

export function showDemoNotice(feature: string): void {
  showToast({
    message: `${feature}暂为演示入口`,
    position: 'bottom',
  })
}
