import { onBeforeUnmount, onMounted, type Ref } from 'vue'

/** Apply the channel's ten-unit design scale for this view. */
export function useChannelRem(container: Ref<HTMLElement | null>): void {
  let previousRootSize = ''
  let previousRootPriority = ''
  let previousBodySize = ''
  let previousBodyPriority = ''
  let active = false

  onMounted(() => {
    const root = document.documentElement
    const body = document.body
    previousRootSize = root.style.getPropertyValue('font-size')
    previousRootPriority = root.style.getPropertyPriority('font-size')
    previousBodySize = body.style.getPropertyValue('font-size')
    previousBodyPriority = body.style.getPropertyPriority('font-size')
    body.style.fontSize = getComputedStyle(body).fontSize
    const width = container.value?.getBoundingClientRect().width ?? 0
    if (width > 0) root.style.fontSize = `${width / 10}px`
    active = true
  })

  onBeforeUnmount(() => {
    if (!active) return
    document.documentElement.style.setProperty('font-size', previousRootSize, previousRootPriority)
    document.body.style.setProperty('font-size', previousBodySize, previousBodyPriority)
  })
}
