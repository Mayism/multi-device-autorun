const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatMoney(minor: number): string {
  return currencyFormatter.format(minor / 100)
}

export function formatAmount(minor: number): string {
  return numberFormatter.format(minor / 100)
}

export function parseYuanToMinor(value: string): number | null {
  const normalized = value.trim().replace(/,/g, '')
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(normalized)) {
    return null
  }

  const [yuan = '0', fraction = ''] = normalized.split('.')
  const minor = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(minor) ? minor : null
}

export function maskMoney(visible: boolean, minor: number): string {
  return visible ? formatMoney(minor) : '¥ ••••••'
}
