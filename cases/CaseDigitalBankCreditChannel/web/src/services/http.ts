import axios, { AxiosError, type AxiosResponse } from 'axios'

import type { ApiEnvelope } from '@/types/banking'

const SESSION_KEY = 'digital-bank.session'

export class BankApiError extends Error {
  constructor(
    message: string,
    public readonly code = 'REQUEST_FAILED',
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'BankApiError'
  }
}

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
  timeout: 8_000,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
})

http.interceptors.request.use((config) => {
  const stored = sessionStorage.getItem(SESSION_KEY)
  if (stored) {
    try {
      const session = JSON.parse(stored) as { token?: string }
      if (session.token) {
        config.headers.set('Authorization', `Bearer ${session.token}`)
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY)
    }
  }
  return config
})

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiEnvelope<unknown>>) => {
    const payload = error.response?.data
    throw new BankApiError(
      payload?.message ??
        (error.code === 'ECONNABORTED' ? '请求超时，请稍后重试' : '网络开小差了，请稍后重试'),
      payload?.code ?? error.code ?? 'REQUEST_FAILED',
      error.response?.status,
    )
  },
)

export function unwrap<T>(response: AxiosResponse<ApiEnvelope<T>>): T {
  if (response.data.code !== '000000') {
    throw new BankApiError(response.data.message, response.data.code, response.status)
  }
  return response.data.data
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试'
}
