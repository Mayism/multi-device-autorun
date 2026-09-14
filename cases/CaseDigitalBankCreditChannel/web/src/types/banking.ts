export type CurrencyCode = 'CNY'

export type AccountType = 'checking' | 'deposit' | 'wallet'
export type TransactionDirection = 'income' | 'expense'
export type TransactionStatus = 'completed' | 'processing' | 'failed'

export interface ApiEnvelope<T> {
  code: string
  message: string
  data: T
  requestId: string
  timestamp: string
}

export interface Customer {
  id: string
  name: string
  maskedMobile: string
  avatarText: string
  riskLevel: '稳健型' | '平衡型' | '成长型'
  lastLoginAt: string
}

export interface LoginPayload {
  mobile: string
  password: string
}

export interface LoginResult {
  token: string
  customer: Customer
}

export interface Account {
  id: string
  name: string
  type: AccountType
  maskedNumber: string
  balanceMinor: number
  availableMinor: number
  currency: CurrencyCode
  accent: 'blue' | 'cyan' | 'violet'
  primary: boolean
}

export interface Transaction {
  id: string
  accountId: string
  title: string
  category: string
  occurredAt: string
  amountMinor: number
  direction: TransactionDirection
  status: TransactionStatus
  counterpart?: string
  note?: string
}

export interface BannerNotice {
  id: string
  title: string
  description: string
  tone: 'blue' | 'green'
}

export interface Dashboard {
  customer: Customer
  totalAssetsMinor: number
  monthIncomeMinor: number
  monthExpenseMinor: number
  assetChangeRate: number
  accounts: Account[]
  recentTransactions: Transaction[]
  notices: BannerNotice[]
}

export interface AccountDetail {
  account: Account
  transactions: Transaction[]
}

export interface Beneficiary {
  id: string
  name: string
  bankName: string
  maskedNumber: string
  avatarText: string
}

export interface TransferPayload {
  fromAccountId: string
  beneficiaryId: string
  amountMinor: number
  remark?: string
}

export interface TransferReceipt {
  id: string
  createdAt: string
  fromAccountName: string
  beneficiaryName: string
  bankName: string
  amountMinor: number
  feeMinor: number
  status: 'completed'
  referenceNumber: string
}

export interface CreditCard {
  id: string
  name: string
  maskedNumber: string
  limitMinor: number
  availableMinor: number
  billMinor: number
  minimumPaymentMinor: number
  dueDate: string
  accent: 'midnight' | 'aurora'
}

export interface RepaymentPayload {
  cardId: string
  fromAccountId: string
  amountMinor: number
}

export interface WealthProduct {
  id: string
  name: string
  category: string
  riskLevel: 'R1' | 'R2' | 'R3'
  annualRateText: string
  periodText: string
  minimumMinor: number
  featured: boolean
}

export interface WealthHolding {
  id: string
  productName: string
  marketValueMinor: number
  profitMinor: number
}

export interface WealthOverview {
  totalHoldingMinor: number
  totalProfitMinor: number
  holdings: WealthHolding[]
  products: WealthProduct[]
}

export interface BankMessage {
  id: string
  category: 'account' | 'service' | 'security'
  title: string
  summary: string
  createdAt: string
  read: boolean
}

export interface ProfileSummary {
  customer: Customer
  identityStatus: '已认证'
  securityLevel: '高'
  deviceCount: number
  servicePhone: string
}
