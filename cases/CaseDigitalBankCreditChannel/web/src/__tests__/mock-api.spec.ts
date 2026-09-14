import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resetMockDatabase } from '@/mocks/database'
import { setupMockApi, teardownMockApi } from '@/mocks'
import { authApi, bankingApi } from '@/services/banking'

describe('digital bank mock API', () => {
  beforeAll(() => setupMockApi())

  beforeEach(() => {
    resetMockDatabase()
    sessionStorage.clear()
  })

  afterAll(() => teardownMockApi())

  it('accepts any valid mobile with the demo password and rejects invalid credentials', async () => {
    const session = await authApi.login({ mobile: '13912345678', password: '123456' })
    expect(session.customer.name).toBe('Admin')
    expect(session.customer.maskedMobile).toBe('139****5678')
    expect(session.token).toBeTruthy()

    await expect(
      authApi.login({ mobile: '13912345678', password: '654321' }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID', status: 401 })
  })

  it('returns a consistent dashboard total', async () => {
    const dashboard = await bankingApi.getDashboard()
    const accountTotal = dashboard.accounts.reduce((total, item) => total + item.balanceMinor, 0)

    expect(dashboard.totalAssetsMinor).toBeGreaterThan(accountTotal)
    expect(dashboard.recentTransactions).toHaveLength(5)
  })

  it('completes a transfer and records the account change', async () => {
    const [account] = await bankingApi.getAccounts()
    const [beneficiary] = await bankingApi.getBeneficiaries()
    expect(account).toBeDefined()
    expect(beneficiary).toBeDefined()

    const originalBalance = account!.balanceMinor
    const receipt = await bankingApi.createTransfer({
      fromAccountId: account!.id,
      beneficiaryId: beneficiary!.id,
      amountMinor: 12_345,
      remark: '自动化验证',
    })
    const detail = await bankingApi.getAccountDetail(account!.id)

    expect(receipt.status).toBe('completed')
    expect(receipt.amountMinor).toBe(12_345)
    expect(detail.account.balanceMinor).toBe(originalBalance - 12_345)
    expect(detail.transactions[0]).toMatchObject({
      counterpart: beneficiary!.name,
      amountMinor: 12_345,
      note: '自动化验证',
    })
  })

  it('persists the read state for a message', async () => {
    const messages = await bankingApi.getMessages()
    const unread = messages.find((message) => !message.read)
    expect(unread).toBeDefined()

    const updated = await bankingApi.markMessageRead(unread!.id)
    const refreshed = await bankingApi.getMessages()

    expect(updated.read).toBe(true)
    expect(refreshed.find((message) => message.id === unread!.id)?.read).toBe(true)
  })

  it('marks every message as read in one operation', async () => {
    const initial = await bankingApi.getMessages()
    expect(initial.some((message) => !message.read)).toBe(true)

    const updated = await bankingApi.markAllMessagesRead()
    const refreshed = await bankingApi.getMessages()

    expect(updated.every((message) => message.read)).toBe(true)
    expect(refreshed.every((message) => message.read)).toBe(true)
  })
})
