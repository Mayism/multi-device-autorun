import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { bankingApi } from '@/services/banking'
import { errorMessage } from '@/services/http'
import type { BankMessage } from '@/types/banking'

export const useNotificationsStore = defineStore('notifications', () => {
  const messages = ref<BankMessage[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref('')

  const unreadCount = computed(() => messages.value.filter((message) => !message.read).length)

  async function load(force = false): Promise<void> {
    if (loading.value || (loaded.value && !force)) return

    loading.value = true
    loadError.value = ''
    try {
      messages.value = await bankingApi.getMessages()
      loaded.value = true
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  async function markMessageRead(messageId: string): Promise<void> {
    const message = messages.value.find((item) => item.id === messageId)
    if (!message || message.read) return

    const updated = await bankingApi.markMessageRead(messageId)
    messages.value = messages.value.map((item) => (item.id === updated.id ? updated : item))
  }

  async function markAllRead(): Promise<void> {
    if (!unreadCount.value) return
    messages.value = await bankingApi.markAllMessagesRead()
    loaded.value = true
  }

  function reset(): void {
    messages.value = []
    loading.value = false
    loaded.value = false
    loadError.value = ''
  }

  return {
    messages,
    loading,
    loaded,
    loadError,
    unreadCount,
    load,
    markMessageRead,
    markAllRead,
    reset,
  }
})
