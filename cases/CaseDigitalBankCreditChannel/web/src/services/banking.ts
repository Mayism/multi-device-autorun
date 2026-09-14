import type {
  Account,
  AccountDetail,
  ApiEnvelope,
  BankMessage,
  Beneficiary,
  CreditCard,
  Dashboard,
  LoginPayload,
  LoginResult,
  ProfileSummary,
  RepaymentPayload,
  TransferPayload,
  TransferReceipt,
  WealthOverview,
} from '@/types/banking'
import { http, unwrap } from './http'

export const authApi = {
  async login(payload: LoginPayload): Promise<LoginResult> {
    return unwrap(await http.post<ApiEnvelope<LoginResult>>('/auth/login', payload))
  },
}

export const bankingApi = {
  async getDashboard(): Promise<Dashboard> {
    return unwrap(await http.get<ApiEnvelope<Dashboard>>('/dashboard'))
  },

  async getAccounts(): Promise<Account[]> {
    return unwrap(await http.get<ApiEnvelope<Account[]>>('/accounts'))
  },

  async getAccountDetail(accountId: string): Promise<AccountDetail> {
    return unwrap(await http.get<ApiEnvelope<AccountDetail>>(`/accounts/${accountId}`))
  },

  async getBeneficiaries(): Promise<Beneficiary[]> {
    return unwrap(await http.get<ApiEnvelope<Beneficiary[]>>('/beneficiaries'))
  },

  async createTransfer(payload: TransferPayload): Promise<TransferReceipt> {
    return unwrap(await http.post<ApiEnvelope<TransferReceipt>>('/transfers', payload))
  },

  async getCards(): Promise<CreditCard[]> {
    return unwrap(await http.get<ApiEnvelope<CreditCard[]>>('/cards'))
  },

  async repayCard(payload: RepaymentPayload): Promise<CreditCard> {
    return unwrap(await http.post<ApiEnvelope<CreditCard>>('/cards/repayments', payload))
  },

  async getWealthOverview(): Promise<WealthOverview> {
    return unwrap(await http.get<ApiEnvelope<WealthOverview>>('/wealth'))
  },

  async getMessages(): Promise<BankMessage[]> {
    return unwrap(await http.get<ApiEnvelope<BankMessage[]>>('/messages'))
  },

  async markMessageRead(messageId: string): Promise<BankMessage> {
    return unwrap(await http.patch<ApiEnvelope<BankMessage>>(`/messages/${messageId}/read`))
  },

  async markAllMessagesRead(): Promise<BankMessage[]> {
    return unwrap(await http.patch<ApiEnvelope<BankMessage[]>>('/messages/read-all'))
  },

  async getProfile(): Promise<ProfileSummary> {
    return unwrap(await http.get<ApiEnvelope<ProfileSummary>>('/profile'))
  },
}
