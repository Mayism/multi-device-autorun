<script setup lang="ts">
import { computed } from 'vue'
import { Icon as VanIcon } from 'vant'

import type { Account } from '@/types/banking'
import { maskMoney } from '@/utils/money'

const props = withDefaults(
  defineProps<{
    account: Account
    balanceVisible?: boolean
    interactive?: boolean
  }>(),
  {
    balanceVisible: true,
    interactive: true,
  },
)

defineEmits<{
  select: [account: Account]
}>()

const iconName = computed(() => {
  if (props.account.type === 'deposit') return 'balance-list-o'
  if (props.account.type === 'wallet') return 'cash-back-record'
  return 'card'
})
</script>

<template>
  <button
    class="account-card"
    :class="[`account-card--${account.accent}`, { 'account-card--static': !interactive }]"
    type="button"
    :disabled="!interactive"
    @click="$emit('select', account)"
  >
    <span class="account-card__topline">
      <span class="account-card__icon"><VanIcon :name="iconName" /></span>
      <span class="account-card__identity">
        <strong>{{ account.name }}</strong>
        <small>{{ account.maskedNumber }}</small>
      </span>
      <VanIcon v-if="interactive" class="account-card__arrow" name="arrow" />
    </span>
    <span class="account-card__balance-label">账户余额</span>
    <strong class="account-card__balance">{{
      maskMoney(balanceVisible, account.balanceMinor)
    }}</strong>
    <span class="account-card__available">
      可用 {{ balanceVisible ? maskMoney(true, account.availableMinor) : '¥ ••••••' }}
    </span>
  </button>
</template>

<style scoped>
.account-card {
  position: relative;
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 190px;
  flex-direction: column;
  align-items: flex-start;
  padding: 20px;
  overflow: hidden;
  border: 0;
  border-radius: var(--bank-radius-lg);
  color: #fff;
  text-align: left;
  box-shadow: 0 18px 32px rgb(8 48 124 / 18%);
  cursor: pointer;
}

.account-card::before,
.account-card::after {
  position: absolute;
  border: 1px solid rgb(255 255 255 / 16%);
  border-radius: 50%;
  content: '';
  pointer-events: none;
}

.account-card::before {
  width: 180px;
  height: 180px;
  top: -90px;
  right: -55px;
}

.account-card::after {
  width: 110px;
  height: 110px;
  right: 25px;
  bottom: -76px;
}

.account-card--blue {
  background: linear-gradient(145deg, #0d70f7, #123ea7);
}

.account-card--cyan {
  background: linear-gradient(145deg, #0fb5c5, #087382);
}

.account-card--violet {
  background: linear-gradient(145deg, #8067eb, #5030a8);
}

.account-card--static {
  cursor: default;
}

.account-card__topline {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.account-card__icon {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 14px;
  background: rgb(255 255 255 / 17%);
  font-size: 21px;
}

.account-card__identity {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.account-card__identity strong {
  font-size: 16px;
  font-weight: 700;
}

.account-card__identity small {
  color: rgb(255 255 255 / 70%);
  font-size: 12px;
  letter-spacing: 0.06em;
}

.account-card__arrow {
  flex: 0 0 auto;
  color: rgb(255 255 255 / 80%);
}

.account-card__balance-label {
  margin-top: 25px;
  color: rgb(255 255 255 / 72%);
  font-size: 12px;
}

.account-card__balance {
  max-width: 100%;
  margin-top: 5px;
  overflow: hidden;
  font-size: clamp(24px, 6vw, 31px);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.03em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-card__available {
  margin-top: auto;
  padding-top: 12px;
  color: rgb(255 255 255 / 76%);
  font-size: 12px;
}

.account-card:focus-visible {
  outline: 3px solid rgb(255 255 255 / 72%);
  outline-offset: -5px;
}
</style>
