import { describe, expect, it } from 'vitest'

import { formatAmount, formatMoney, parseYuanToMinor } from '@/utils/money'

describe('money utilities', () => {
  it('converts yuan input to integer minor units without floating point arithmetic', () => {
    expect(parseYuanToMinor('0.01')).toBe(1)
    expect(parseYuanToMinor('1,286.50')).toBe(128_650)
    expect(parseYuanToMinor('200')).toBe(20_000)
  })

  it('rejects malformed or over-precise amounts', () => {
    expect(parseYuanToMinor('-1')).toBeNull()
    expect(parseYuanToMinor('12.345')).toBeNull()
    expect(parseYuanToMinor('1e3')).toBeNull()
    expect(parseYuanToMinor('')).toBeNull()
  })

  it('formats minor units for display', () => {
    expect(formatAmount(12_345)).toBe('123.45')
    expect(formatMoney(12_345)).toContain('123.45')
  })
})
