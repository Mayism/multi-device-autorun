import AxiosMockAdapter from 'axios-mock-adapter'

import { http } from '@/services/http'
import type {
  AccountDetail,
  ApiEnvelope,
  Dashboard,
  LoginPayload,
  LoginResult,
  ProfileSummary,
  RepaymentPayload,
  TransferPayload,
  TransferReceipt,
  WealthOverview,
} from '@/types/banking'
import { loginFormSchema } from '@/utils/validation'
import { getMockDatabase, nextRequestId } from './database'

let adapter: AxiosMockAdapter | null = null

function clone<T>(value: T): T {
  return structuredClone(value)
}

function envelope<T>(data: T, message = '操作成功'): ApiEnvelope<T> {
  return {
    code: '000000',
    message,
    data: clone(data),
    requestId: nextRequestId(),
    timestamp: new Date().toISOString(),
  }
}

function failure(code: string, message: string): ApiEnvelope<null> {
  return {
    code,
    message,
    data: null,
    requestId: nextRequestId(),
    timestamp: new Date().toISOString(),
  }
}

function parseBody<T>(data: unknown): T {
  if (typeof data === 'string') {
    return JSON.parse(data) as T
  }
  return data as T
}

function pathId(url: string | undefined, segmentFromEnd: number): string {
  const parts = (url ?? '').split('/').filter(Boolean)
  return decodeURIComponent(parts[parts.length - segmentFromEnd] ?? '')
}

function newestFirst<T extends { createdAt?: string; occurredAt?: string }>(
  left: T,
  right: T,
): number {
  const leftTime = Date.parse(left.createdAt ?? left.occurredAt ?? '')
  const rightTime = Date.parse(right.createdAt ?? right.occurredAt ?? '')
  return rightTime - leftTime
}

export function setupMockApi(): AxiosMockAdapter {
  if (adapter) {
    return adapter
  }

  adapter = new AxiosMockAdapter(http, {
    delayResponse: import.meta.env.MODE === 'test' ? 0 : 420,
    onNoMatch: 'throwException',
  })

  adapter.onPost('/auth/login').reply((config) => {
    const payload = parseBody<LoginPayload>(config.data)
    const parsed = loginFormSchema.safeParse(payload)
    if (!parsed.success) {
      return [401, failure('AUTH_INVALID', '手机号或登录密码不正确')]
    }

    const db = getMockDatabase()
    db.customer.maskedMobile = `${parsed.data.mobile.slice(0, 3)}****${parsed.data.mobile.slice(-4)}`
    const result: LoginResult = {
      token: 'mock-session-token-digital-bank',
      customer: db.customer,
    }
    return [200, envelope(result, '登录成功')]
  })

  adapter.onGet('/dashboard').reply(() => {
    const db = getMockDatabase()
    const totalAssetsMinor =
      db.accounts.reduce((total, account) => total + account.balanceMinor, 0) +
      db.holdings.reduce((total, holding) => total + holding.marketValueMinor, 0)
    const recentTransactions = [...db.transactions].sort(newestFirst).slice(0, 5)

    const dashboard: Dashboard = {
      customer: db.customer,
      totalAssetsMinor,
      monthIncomeMinor: 3_266_642,
      monthExpenseMinor: 856_820,
      assetChangeRate: 1.82,
      accounts: db.accounts,
      recentTransactions,
      notices: [
        {
          id: 'notice-001',
          title: '账户安全体检',
          description: '本月账户状态良好，建议定期更新登录密码。',
          tone: 'blue',
        },
        {
          id: 'notice-002',
          title: '理财到期提醒',
          description: '您有一笔稳健产品将在 12 天后到期。',
          tone: 'green',
        },
      ],
    }
    return [200, envelope(dashboard)]
  })

  adapter.onGet('/accounts').reply(() => [200, envelope(getMockDatabase().accounts)])

  adapter.onGet(/^\/accounts\/[^/]+$/).reply((config) => {
    const accountId = pathId(config.url, 1)
    const db = getMockDatabase()
    const account = db.accounts.find((item) => item.id === accountId)
    if (!account) {
      return [404, failure('ACCOUNT_NOT_FOUND', '未找到该账户')]
    }

    const detail: AccountDetail = {
      account,
      transactions: db.transactions
        .filter((item) => item.accountId === accountId)
        .sort(newestFirst),
    }
    return [200, envelope(detail)]
  })

  adapter.onGet('/beneficiaries').reply(() => [200, envelope(getMockDatabase().beneficiaries)])

  adapter.onPost('/transfers').reply((config) => {
    const payload = parseBody<TransferPayload>(config.data)
    const db = getMockDatabase()
    const account = db.accounts.find((item) => item.id === payload.fromAccountId)
    const beneficiary = db.beneficiaries.find((item) => item.id === payload.beneficiaryId)

    if (!account || !beneficiary) {
      return [422, failure('TRANSFER_INVALID', '付款账户或收款人无效')]
    }
    if (!Number.isSafeInteger(payload.amountMinor) || payload.amountMinor <= 0) {
      return [422, failure('AMOUNT_INVALID', '请输入有效的转账金额')]
    }
    if (payload.amountMinor > account.availableMinor) {
      return [422, failure('BALANCE_INSUFFICIENT', '账户可用余额不足')]
    }

    account.balanceMinor -= payload.amountMinor
    account.availableMinor -= payload.amountMinor
    db.transferSequence += 1
    const createdAt = new Date().toISOString()
    const transferId = `transfer-${db.transferSequence}`
    db.transactions.unshift({
      id: `txn-${db.transferSequence}`,
      accountId: account.id,
      title: '转账',
      category: '转账',
      occurredAt: createdAt,
      amountMinor: payload.amountMinor,
      direction: 'expense',
      status: 'completed',
      counterpart: beneficiary.name,
      note: payload.remark,
    })

    const receipt: TransferReceipt = {
      id: transferId,
      createdAt,
      fromAccountName: `${account.name} ${account.maskedNumber}`,
      beneficiaryName: beneficiary.name,
      bankName: beneficiary.bankName,
      amountMinor: payload.amountMinor,
      feeMinor: 0,
      status: 'completed',
      referenceNumber: `DB${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${db.transferSequence}`,
    }
    return [200, envelope(receipt, '转账成功')]
  })

  adapter.onGet('/cards').reply(() => [200, envelope(getMockDatabase().cards)])

  adapter.onPost('/cards/repayments').reply((config) => {
    const payload = parseBody<RepaymentPayload>(config.data)
    const db = getMockDatabase()
    const card = db.cards.find((item) => item.id === payload.cardId)
    const account = db.accounts.find((item) => item.id === payload.fromAccountId)
    if (!card || !account || payload.amountMinor <= 0) {
      return [422, failure('REPAYMENT_INVALID', '还款信息不完整')]
    }
    if (payload.amountMinor > account.availableMinor) {
      return [422, failure('BALANCE_INSUFFICIENT', '付款账户余额不足')]
    }

    const settledMinor = Math.min(payload.amountMinor, card.billMinor)
    account.balanceMinor -= settledMinor
    account.availableMinor -= settledMinor
    card.billMinor -= settledMinor
    card.minimumPaymentMinor = Math.min(card.minimumPaymentMinor, card.billMinor)
    card.availableMinor = Math.min(card.limitMinor, card.availableMinor + settledMinor)
    db.transactions.unshift({
      id: `txn-card-${Date.now()}`,
      accountId: account.id,
      title: '信用卡还款',
      category: '还款',
      occurredAt: new Date().toISOString(),
      amountMinor: settledMinor,
      direction: 'expense',
      status: 'completed',
      counterpart: card.name,
    })
    return [200, envelope(card, '还款成功')]
  })

  adapter.onGet('/wealth').reply(() => {
    const db = getMockDatabase()
    const overview: WealthOverview = {
      totalHoldingMinor: db.holdings.reduce((total, item) => total + item.marketValueMinor, 0),
      totalProfitMinor: db.holdings.reduce((total, item) => total + item.profitMinor, 0),
      holdings: db.holdings,
      products: db.products,
    }
    return [200, envelope(overview)]
  })

  adapter.onGet('/messages').reply(() => {
    const messages = [...getMockDatabase().messages].sort(newestFirst)
    return [200, envelope(messages)]
  })

  adapter.onPatch('/messages/read-all').reply(() => {
    const messages = getMockDatabase().messages
    messages.forEach((message) => {
      message.read = true
    })
    return [200, envelope([...messages].sort(newestFirst), '全部消息已读')]
  })

  adapter.onPatch(/^\/messages\/[^/]+\/read$/).reply((config) => {
    const messageId = pathId(config.url, 2)
    const message = getMockDatabase().messages.find((item) => item.id === messageId)
    if (!message) {
      return [404, failure('MESSAGE_NOT_FOUND', '消息不存在')]
    }
    message.read = true
    return [200, envelope(message)]
  })

  adapter.onGet('/profile').reply(() => {
    const profile: ProfileSummary = {
      customer: getMockDatabase().customer,
      identityStatus: '已认证',
      securityLevel: '高',
      deviceCount: 2,
      servicePhone: '95300',
    }
    return [200, envelope(profile)]
  })

  return adapter
}

export function teardownMockApi(): void {
  adapter?.restore()
  adapter = null
}
