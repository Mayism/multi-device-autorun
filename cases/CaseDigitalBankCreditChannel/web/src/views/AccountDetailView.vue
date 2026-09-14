<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Button as VanButton, Icon as VanIcon, Skeleton as VanSkeleton } from 'vant'

import AccountCard from '@/components/AccountCard.vue'
import SectionHeading from '@/components/SectionHeading.vue'
import TransactionItem from '@/components/TransactionItem.vue'
import { bankingApi } from '@/services/banking'
import { errorMessage } from '@/services/http'
import type { AccountDetail } from '@/types/banking'
import { showDemoNotice } from '@/utils/feedback'
import { formatMoney } from '@/utils/money'

const route = useRoute()
const router = useRouter()
const detail = ref<AccountDetail | null>(null)
const loading = ref(true)
const loadError = ref('')

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    detail.value = await bankingApi.getAccountDetail(String(route.params.accountId))
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="app-page account-detail-page">
    <header class="page-topbar">
      <div class="page-topbar__left">
        <button class="page-topbar__back" type="button" aria-label="返回" @click="router.back()">
          <VanIcon name="arrow-left" size="20" />
        </button>
        <h1>账户详情</h1>
      </div>
      <button class="page-topbar__action" type="button" @click="showDemoNotice('账户管理')">
        管理
      </button>
    </header>

    <div v-if="loading" class="skeleton-stack">
      <VanSkeleton title :row="4" />
      <VanSkeleton title :row="6" />
    </div>

    <section v-else-if="loadError" class="surface-card data-state">
      <div class="data-state__content">
        <VanIcon name="warning-o" size="38" color="#dc4a5d" />
        <h2>账户详情加载失败</h2>
        <p>{{ loadError }}</p>
        <VanButton type="primary" round @click="load">重新加载</VanButton>
      </div>
    </section>

    <template v-else-if="detail">
      <div class="detail-grid">
        <AccountCard :account="detail.account" :interactive="false" />
        <section class="surface-card account-facts">
          <div>
            <span>可用余额</span>
            <strong>{{ formatMoney(detail.account.availableMinor) }}</strong>
          </div>
          <div>
            <span>账户币种</span>
            <strong>人民币 CNY</strong>
          </div>
          <div>
            <span>账户状态</span>
            <strong class="positive-text">正常</strong>
          </div>
          <button type="button" @click="router.push({ name: 'transfer' })">
            <VanIcon name="exchange" /> 转出
          </button>
        </section>
      </div>

      <section class="section-block">
        <SectionHeading title="交易明细" description="按交易时间由近到远排列" />
        <div v-if="detail.transactions.length" class="surface-card transaction-list">
          <TransactionItem
            v-for="transaction in detail.transactions"
            :key="transaction.id"
            :transaction="transaction"
          />
        </div>
        <div v-else class="surface-card data-state">
          <div class="data-state__content">
            <VanIcon name="orders-o" size="38" color="#aab4c4" />
            <h2>暂无交易记录</h2>
            <p>该账户尚未产生可展示的交易。</p>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.detail-grid {
  display: grid;
  min-width: 0;
  gap: 16px;
}

.account-facts {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 19px 12px;
  padding: 22px;
}

.account-facts div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
}

.account-facts span {
  color: var(--bank-ink-500);
  font-size: 12px;
}

.account-facts strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-facts button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 0;
  border-radius: 14px;
  color: #fff;
  background: var(--bank-blue-600);
  font-weight: 680;
  cursor: pointer;
}

.transaction-list {
  padding: 0 18px;
}

@media (min-width: 720px) {
  .detail-grid {
    grid-template-columns: minmax(0, 1.1fr) minmax(300px, 0.9fr);
    align-items: stretch;
  }

  .detail-grid :deep(.account-card) {
    height: 100%;
  }
}
</style>
