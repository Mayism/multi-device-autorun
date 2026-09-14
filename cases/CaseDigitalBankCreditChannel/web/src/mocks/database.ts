import type {
  Account,
  BankMessage,
  Beneficiary,
  CreditCard,
  Customer,
  Transaction,
  WealthHolding,
  WealthProduct,
} from '@/types/banking'

export interface MockDatabase {
  customer: Customer
  accounts: Account[]
  transactions: Transaction[]
  beneficiaries: Beneficiary[]
  cards: CreditCard[]
  holdings: WealthHolding[]
  products: WealthProduct[]
  messages: BankMessage[]
  transferSequence: number
}

const seed: MockDatabase = {
  customer: {
    id: 'customer-demo-001',
    name: 'Admin',
    maskedMobile: '138****8000',
    avatarText: 'A',
    riskLevel: '平衡型',
    lastLoginAt: '2026-09-04T08:20:00+08:00',
  },
  accounts: [
    {
      id: 'account-checking-001',
      name: '活期账户',
      type: 'checking',
      maskedNumber: '**** 8892',
      balanceMinor: 18_652_068,
      availableMinor: 18_652_068,
      currency: 'CNY',
      accent: 'blue',
      primary: true,
    },
    {
      id: 'account-deposit-001',
      name: '安心定期',
      type: 'deposit',
      maskedNumber: '**** 2066',
      balanceMinor: 12_000_000,
      availableMinor: 0,
      currency: 'CNY',
      accent: 'violet',
      primary: false,
    },
    {
      id: 'account-wallet-001',
      name: '随心钱包',
      type: 'wallet',
      maskedNumber: '**** 5178',
      balanceMinor: 2_860_056,
      availableMinor: 2_860_056,
      currency: 'CNY',
      accent: 'cyan',
      primary: false,
    },
  ],
  transactions: [
    {
      id: 'txn-001',
      accountId: 'account-checking-001',
      title: '工资收入',
      category: '工资',
      occurredAt: '2026-09-04T09:30:00+08:00',
      amountMinor: 3_258_000,
      direction: 'income',
      status: 'completed',
      counterpart: '示例科技有限公司',
    },
    {
      id: 'txn-002',
      accountId: 'account-checking-001',
      title: '生活消费',
      category: '购物',
      occurredAt: '2026-09-03T19:12:00+08:00',
      amountMinor: 32_680,
      direction: 'expense',
      status: 'completed',
      counterpart: '数字生活超市',
    },
    {
      id: 'txn-003',
      accountId: 'account-checking-001',
      title: '转账',
      category: '转账',
      occurredAt: '2026-09-02T14:08:00+08:00',
      amountMinor: 250_000,
      direction: 'expense',
      status: 'completed',
      counterpart: '周然',
      note: '房租分摊',
    },
    {
      id: 'txn-004',
      accountId: 'account-wallet-001',
      title: '出行服务',
      category: '交通',
      occurredAt: '2026-09-02T08:42:00+08:00',
      amountMinor: 4_280,
      direction: 'expense',
      status: 'completed',
      counterpart: '城市出行',
    },
    {
      id: 'txn-005',
      accountId: 'account-checking-001',
      title: '活期结息',
      category: '利息',
      occurredAt: '2026-09-01T00:05:00+08:00',
      amountMinor: 8_642,
      direction: 'income',
      status: 'completed',
      counterpart: '数字银行',
    },
    {
      id: 'txn-006',
      accountId: 'account-wallet-001',
      title: '餐饮消费',
      category: '餐饮',
      occurredAt: '2026-08-31T12:26:00+08:00',
      amountMinor: 8_960,
      direction: 'expense',
      status: 'completed',
      counterpart: '晴日餐厅',
    },
  ],
  beneficiaries: [
    {
      id: 'beneficiary-001',
      name: '周然',
      bankName: '数字银行',
      maskedNumber: '**** 1024',
      avatarText: '周',
    },
    {
      id: 'beneficiary-002',
      name: '陈屿',
      bankName: '城市商业银行',
      maskedNumber: '**** 6631',
      avatarText: '陈',
    },
    {
      id: 'beneficiary-003',
      name: '示例物业服务',
      bankName: '联合银行',
      maskedNumber: '**** 7908',
      avatarText: '物',
    },
  ],
  cards: [
    {
      id: 'card-001',
      name: '数字臻选信用卡',
      maskedNumber: '**** 3658',
      limitMinor: 5_000_000,
      availableMinor: 4_641_080,
      billMinor: 358_920,
      minimumPaymentMinor: 35_892,
      dueDate: '2026-09-18',
      accent: 'midnight',
    },
    {
      id: 'card-002',
      name: '数字生活信用卡',
      maskedNumber: '**** 7012',
      limitMinor: 3_000_000,
      availableMinor: 2_873_200,
      billMinor: 126_800,
      minimumPaymentMinor: 12_680,
      dueDate: '2026-09-22',
      accent: 'aurora',
    },
  ],
  holdings: [
    {
      id: 'holding-001',
      productName: '稳健日日盈',
      marketValueMinor: 5_620_040,
      profitMinor: 42_680,
    },
    {
      id: 'holding-002',
      productName: '优选固收 90 天',
      marketValueMinor: 2_942_000,
      profitMinor: 18_260,
    },
  ],
  products: [
    {
      id: 'product-001',
      name: '稳健日日盈',
      category: '现金管理',
      riskLevel: 'R1',
      annualRateText: '2.18%',
      periodText: '灵活申赎',
      minimumMinor: 100,
      featured: true,
    },
    {
      id: 'product-002',
      name: '优选固收 90 天',
      category: '固定收益',
      riskLevel: 'R2',
      annualRateText: '3.26%',
      periodText: '90 天',
      minimumMinor: 100_000,
      featured: true,
    },
    {
      id: 'product-003',
      name: '均衡成长精选',
      category: '混合策略',
      riskLevel: 'R3',
      annualRateText: '4.85%',
      periodText: '持有 180 天',
      minimumMinor: 1_000_000,
      featured: false,
    },
  ],
  messages: [
    {
      id: 'message-001',
      category: 'account',
      title: '账户入账提醒',
      summary: '您的活期账户收到一笔工资收入，资金已经到账。',
      createdAt: '2026-09-04T09:31:00+08:00',
      read: false,
    },
    {
      id: 'message-002',
      category: 'security',
      title: '登录安全提醒',
      summary: '您的账户刚刚在一台已信任设备上登录。',
      createdAt: '2026-09-04T08:21:00+08:00',
      read: false,
    },
    {
      id: 'message-003',
      category: 'service',
      title: '信用卡账单已出',
      summary: '本期账单已生成，请在到期还款日前完成还款。',
      createdAt: '2026-09-02T10:00:00+08:00',
      read: true,
    },
    {
      id: 'message-004',
      category: 'service',
      title: '服务时间调整通知',
      summary: '部分理财服务将在周末短时维护，账户查询不受影响。',
      createdAt: '2026-08-30T16:00:00+08:00',
      read: true,
    },
  ],
  transferSequence: 1008,
}

let database = structuredClone(seed)
let requestSequence = 1

export function getMockDatabase(): MockDatabase {
  return database
}

export function resetMockDatabase(): void {
  database = structuredClone(seed)
  requestSequence = 1
}

export function nextRequestId(): string {
  const id = `mock-${String(requestSequence).padStart(6, '0')}`
  requestSequence += 1
  return id
}
