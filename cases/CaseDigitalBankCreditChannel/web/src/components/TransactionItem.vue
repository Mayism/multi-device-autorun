<script setup lang="ts">
import { computed } from 'vue'
import { Icon as VanIcon } from 'vant'

import type { Transaction } from '@/types/banking'
import { formatAmount } from '@/utils/money'

const props = defineProps<{
  transaction: Transaction
}>()

const iconName = computed(() => {
  const icons: Record<string, string> = {
    工资: 'gold-coin-o',
    购物: 'shopping-cart-o',
    转账: 'exchange',
    交通: 'logistics',
    利息: 'chart-trending-o',
    餐饮: 'shop-o',
    还款: 'credit-pay',
  }
  return icons[props.transaction.category] ?? 'balance-o'
})

const dateText = computed(() => {
  const date = new Date(props.transaction.occurredAt)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
})
</script>

<template>
  <div class="transaction-item">
    <span
      class="transaction-item__icon"
      :class="`transaction-item__icon--${transaction.direction}`"
    >
      <VanIcon :name="iconName" />
    </span>
    <span class="transaction-item__main">
      <strong>{{ transaction.title }}</strong>
      <small>{{ transaction.counterpart ?? transaction.category }} · {{ dateText }}</small>
    </span>
    <span
      class="transaction-item__amount"
      :class="`transaction-item__amount--${transaction.direction}`"
    >
      {{ transaction.direction === 'income' ? '+' : '-'
      }}{{ formatAmount(transaction.amountMinor) }}
      <small>{{ transaction.status === 'processing' ? '处理中' : '人民币' }}</small>
    </span>
  </div>
</template>

<style scoped>
.transaction-item {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 13px;
  padding: 15px 0;
}

.transaction-item + .transaction-item {
  border-top: 1px solid var(--bank-line);
}

.transaction-item__icon {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 14px;
  font-size: 19px;
}

.transaction-item__icon--income {
  color: var(--bank-green-600);
  background: #eaf9f3;
}

.transaction-item__icon--expense {
  color: var(--bank-blue-700);
  background: #edf4ff;
}

.transaction-item__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 5px;
}

.transaction-item__main strong,
.transaction-item__main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.transaction-item__main strong {
  font-size: 14px;
}

.transaction-item__main small {
  color: var(--bank-ink-500);
  font-size: 12px;
}

.transaction-item__amount {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  font-size: 15px;
  font-weight: 720;
  font-variant-numeric: tabular-nums;
}

.transaction-item__amount--income {
  color: var(--bank-green-600);
}

.transaction-item__amount--expense {
  color: var(--bank-ink-900);
}

.transaction-item__amount small {
  margin-top: 5px;
  color: var(--bank-ink-500);
  font-size: 10px;
  font-weight: 500;
}
</style>
