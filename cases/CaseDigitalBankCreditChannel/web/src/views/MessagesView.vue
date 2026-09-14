<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import {
  Badge as VanBadge,
  Button as VanButton,
  Icon as VanIcon,
  Skeleton as VanSkeleton,
  Tab as VanTab,
  Tabs as VanTabs,
} from 'vant'

import { useNotificationsStore } from '@/stores/notifications'
import type { BankMessage } from '@/types/banking'

const notifications = useNotificationsStore()
const { messages, loading, loadError, unreadCount } = storeToRefs(notifications)
const activeCategory = ref('all')
const markingAllRead = ref(false)

void notifications.load()

const filteredMessages = computed(() => {
  if (activeCategory.value === 'all') return messages.value
  return messages.value.filter((message) => message.category === activeCategory.value)
})

function messageIcon(category: BankMessage['category']): string {
  if (category === 'account') return 'balance-o'
  if (category === 'security') return 'shield-o'
  return 'volume-o'
}

function messageCategory(category: BankMessage['category']): string {
  if (category === 'account') return '账户动态'
  if (category === 'security') return '安全提醒'
  return '服务通知'
}

function dateText(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

async function openMessage(message: BankMessage): Promise<void> {
  if (message.read) return
  try {
    await notifications.markMessageRead(message.id)
  } catch {
    // Reading a message is non-critical; retain the unread marker when the operation fails.
  }
}

async function markAllRead(): Promise<void> {
  markingAllRead.value = true
  try {
    await notifications.markAllRead()
  } finally {
    markingAllRead.value = false
  }
}
</script>

<template>
  <div class="app-page messages-page">
    <header class="page-topbar">
      <div class="messages-title">
        <h1>消息</h1>
        <VanBadge v-if="unreadCount" :content="unreadCount" max="99" />
      </div>
      <button
        class="page-topbar__action"
        type="button"
        :disabled="!unreadCount || markingAllRead"
        @click="markAllRead"
      >
        {{ markingAllRead ? '处理中…' : '全部已读' }}
      </button>
    </header>

    <div v-if="loading" class="skeleton-stack">
      <VanSkeleton title :row="7" />
    </div>

    <section v-else-if="loadError" class="surface-card data-state">
      <div class="data-state__content">
        <VanIcon name="warning-o" size="38" color="#dc4a5d" />
        <h2>消息加载失败</h2>
        <p>{{ loadError }}</p>
        <VanButton type="primary" round @click="notifications.load(true)">重新加载</VanButton>
      </div>
    </section>

    <template v-else>
      <VanTabs v-model:active="activeCategory" class="message-tabs" shrink>
        <VanTab title="全部" name="all" />
        <VanTab title="账户" name="account" />
        <VanTab title="服务" name="service" />
        <VanTab title="安全" name="security" />
      </VanTabs>

      <section v-if="filteredMessages.length" class="message-list surface-card">
        <button
          v-for="message in filteredMessages"
          :key="message.id"
          class="message-item"
          :class="{ 'message-item--unread': !message.read }"
          type="button"
          @click="openMessage(message)"
        >
          <span class="message-item__icon" :class="`message-item__icon--${message.category}`">
            <VanIcon :name="messageIcon(message.category)" />
          </span>
          <span class="message-item__body">
            <span class="message-item__meta">
              <strong>{{ message.title }}</strong>
              <small>{{ dateText(message.createdAt) }}</small>
            </span>
            <span class="message-item__category">{{ messageCategory(message.category) }}</span>
            <p>{{ message.summary }}</p>
          </span>
          <span v-if="!message.read" class="message-item__dot" aria-label="未读"></span>
        </button>
      </section>

      <section v-else class="surface-card data-state">
        <div class="data-state__content">
          <VanIcon name="comment-o" size="38" color="#aab4c4" />
          <h2>暂无消息</h2>
          <p>当前分类没有新的通知。</p>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.messages-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.messages-title h1 {
  margin: 0;
  font-size: clamp(21px, 4vw, 28px);
}

.page-topbar__action:disabled {
  color: var(--bank-ink-300);
}

.message-tabs {
  margin: 0 calc(var(--bank-page-gutter) * -0.2) 16px;
}

.message-tabs :deep(.van-tabs__nav) {
  background: transparent;
}

.message-tabs :deep(.van-tab) {
  min-width: 62px;
}

.message-list {
  padding: 0 18px;
}

.message-item {
  position: relative;
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: flex-start;
  gap: 13px;
  padding: 18px 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.message-item + .message-item {
  border-top: 1px solid var(--bank-line);
}

.message-item__icon {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 14px;
  font-size: 20px;
}

.message-item__icon--account {
  color: var(--bank-blue-700);
  background: #edf4ff;
}

.message-item__icon--service {
  color: #8056d6;
  background: #f2edff;
}

.message-item__icon--security {
  color: var(--bank-green-600);
  background: #e9f8f2;
}

.message-item__body {
  display: block;
  min-width: 0;
  flex: 1;
}

.message-item__meta {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.message-item__meta strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-item__meta small {
  flex: 0 0 auto;
  color: var(--bank-ink-300);
  font-size: 10px;
}

.message-item__category {
  display: inline-block;
  margin-top: 5px;
  color: var(--bank-blue-700);
  font-size: 10px;
}

.message-item__body p {
  display: -webkit-box;
  margin: 8px 0 0;
  overflow: hidden;
  color: var(--bank-ink-500);
  font-size: 12px;
  line-height: 1.65;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.message-item__dot {
  position: absolute;
  width: 7px;
  height: 7px;
  top: 21px;
  left: 34px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: var(--bank-red-600);
}

.message-item:not(.message-item--unread) {
  opacity: 0.78;
}

@media (min-width: 720px) {
  .message-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 24px;
  }

  .message-item:nth-child(2) {
    border-top: 0;
  }
}
</style>
