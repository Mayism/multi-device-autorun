const fullDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const shortDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
})

export function formatDateTime(value: string): string {
  return fullDateFormatter.format(new Date(value))
}

export function formatShortDate(value: string): string {
  return shortDateFormatter.format(new Date(value))
}
