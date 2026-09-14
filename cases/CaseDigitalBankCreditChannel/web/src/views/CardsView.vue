<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Button as VanButton,
  Field as VanField,
  Icon as VanIcon,
  Popup as VanPopup,
  Skeleton as VanSkeleton,
  showSuccessToast,
} from 'vant'

import CreditCardChannel from '@/components/CreditCardChannel.vue'
import { bankingApi } from '@/services/banking'
import { errorMessage } from '@/services/http'
import type { Account, CreditCard } from '@/types/banking'
import { showDemoNotice } from '@/utils/feedback'
import { formatAmount, formatMoney, parseYuanToMinor } from '@/utils/money'

const router = useRouter()
const cards = ref<CreditCard[]>([])
const accounts = ref<Account[]>([])
const loading = ref(true)
const loadError = ref('')
const showRepayment = ref(false)
const selectedCardId = ref('')
const selectedAccountId = ref('')
const repaymentText = ref('')
const repaymentError = ref('')
const repaying = ref(false)

const selectedCard = computed(() => cards.value.find((card) => card.id === selectedCardId.value))
const paymentAccounts = computed(() =>
  accounts.value.filter((account) => account.availableMinor > 0),
)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const [cardResult, accountResult] = await Promise.all([
      bankingApi.getCards(),
      bankingApi.getAccounts(),
    ])
    cards.value = cardResult
    accounts.value = accountResult
    selectedAccountId.value = accountResult.find((account) => account.primary)?.id ?? ''
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

function openRepayment(card: CreditCard, amountMinor = card.billMinor): void {
  selectedCardId.value = card.id
  repaymentText.value = (amountMinor / 100).toFixed(2)
  repaymentError.value = ''
  showRepayment.value = true
}

async function repay(): Promise<void> {
  repaymentError.value = ''
  const amountMinor = parseYuanToMinor(repaymentText.value)
  if (!selectedCard.value || !selectedAccountId.value || amountMinor === null || amountMinor <= 0) {
    repaymentError.value = '请填写完整、有效的还款信息'
    return
  }

  repaying.value = true
  try {
    const updated = await bankingApi.repayCard({
      cardId: selectedCard.value.id,
      fromAccountId: selectedAccountId.value,
      amountMinor,
    })
    cards.value = cards.value.map((card) => (card.id === updated.id ? updated : card))
    showRepayment.value = false
    showSuccessToast('还款成功')
  } catch (error) {
    repaymentError.value = errorMessage(error)
  } finally {
    repaying.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="app-page cards-page">
    <header class="page-topbar">
      <div class="page-topbar__left">
        <button class="page-topbar__back" type="button" aria-label="返回" @click="router.back()">
          <VanIcon name="arrow-left" size="20" />
        </button>
        <h1>信用卡</h1>
      </div>
      <button class="page-topbar__action" type="button" @click="showDemoNotice('更多卡片服务')">
        更多服务
      </button>
    </header>

    <div v-if="loading" class="skeleton-stack">
      <VanSkeleton title :row="4" />
      <VanSkeleton title :row="5" />
    </div>

    <section v-else-if="loadError" class="surface-card data-state">
      <div class="data-state__content">
        <VanIcon name="warning-o" size="38" color="#dc4a5d" />
        <h2>信用卡服务暂不可用</h2>
        <p>{{ loadError }}</p>
        <VanButton type="primary" round @click="load">重新加载</VanButton>
      </div>
    </section>

    <CreditCardChannel v-else :cards="cards" @repay="openRepayment" />

    <VanPopup
      v-model:show="showRepayment"
      class="repayment-popup"
      position="bottom"
      round
      closeable
      safe-area-inset-bottom
    >
      <div v-if="selectedCard" class="repayment-content">
        <span class="status-chip">信用卡还款</span>
        <h2>{{ selectedCard.name }}</h2>
        <p>本期账单 {{ formatMoney(selectedCard.billMinor) }}</p>

        <label for="repayment-amount">还款金额</label>
        <div class="repayment-amount">
          <span>¥</span>
          <input id="repayment-amount" v-model="repaymentText" inputmode="decimal" />
        </div>

        <VanField
          v-model="selectedAccountId"
          label="付款账户"
          name="account"
          class="repayment-account"
        >
          <template #input>
            <select v-model="selectedAccountId">
              <option v-for="account in paymentAccounts" :key="account.id" :value="account.id">
                {{ account.name }} {{ account.maskedNumber }}（可用
                {{ formatAmount(account.availableMinor) }}）
              </option>
            </select>
          </template>
        </VanField>

        <p v-if="repaymentError" class="repayment-error" role="alert">
          <VanIcon name="warning-o" /> {{ repaymentError }}
        </p>
        <VanButton type="primary" block round :loading="repaying" @click="repay"
          >确认还款</VanButton
        >
      </div>
    </VanPopup>
  </div>
</template>

<style scoped>
.repayment-popup {
  left: 50%;
  width: min(100%, 640px);
  transform: translateX(-50%);
}

.repayment-content {
  padding: 30px clamp(20px, 5vw, 36px) max(26px, env(safe-area-inset-bottom));
}

.repayment-content h2 {
  margin: 17px 0 6px;
  font-size: 22px;
}

.repayment-content > p {
  margin: 0;
  color: var(--bank-ink-500);
  font-size: 13px;
}

.repayment-content > label {
  display: block;
  margin-top: 26px;
  color: var(--bank-ink-700);
  font-size: 13px;
  font-weight: 650;
}

.repayment-amount {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0 18px;
  border-bottom: 1px solid var(--bank-line);
}

.repayment-amount span {
  font-size: 23px;
  font-weight: 700;
}

.repayment-amount input {
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  font-size: 34px;
  font-weight: 760;
  font-variant-numeric: tabular-nums;
}

.repayment-account {
  margin: 8px 0 16px;
}

.repayment-account select {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  color: var(--bank-ink-900);
  background: transparent;
  font-size: 13px;
}

.repayment-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -4px 0 14px !important;
  color: var(--bank-red-600) !important;
}
</style>
