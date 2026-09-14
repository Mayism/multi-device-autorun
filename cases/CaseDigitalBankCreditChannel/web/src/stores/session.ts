import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { authApi } from '@/services/banking'
import type { Customer, LoginPayload } from '@/types/banking'

const SESSION_KEY = 'digital-bank.session'

interface StoredSession {
  token: string
  customer: Customer
}

export const useSessionStore = defineStore('session', () => {
  const token = ref('')
  const customer = ref<Customer | null>(null)
  const restored = ref(false)

  const isAuthenticated = computed(() => Boolean(token.value && customer.value))

  function restore(): void {
    if (restored.value) {
      return
    }
    restored.value = true
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) {
      return
    }

    try {
      const stored = JSON.parse(raw) as StoredSession
      if (stored.token && stored.customer?.id) {
        token.value = stored.token
        customer.value = stored.customer
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY)
    }
  }

  async function login(payload: LoginPayload): Promise<void> {
    const result = await authApi.login(payload)
    token.value = result.token
    customer.value = result.customer
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ token: result.token, customer: result.customer } satisfies StoredSession),
    )
  }

  function logout(): void {
    token.value = ''
    customer.value = null
    sessionStorage.removeItem(SESSION_KEY)
  }

  return { token, customer, restored, isAuthenticated, restore, login, logout }
})
