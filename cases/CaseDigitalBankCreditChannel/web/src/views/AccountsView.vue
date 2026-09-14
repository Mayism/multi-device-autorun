<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Button as VanButton, Icon as VanIcon, Skeleton as VanSkeleton } from 'vant'

import AccountCard from '@/components/AccountCard.vue'
import { bankingApi } from '@/services/banking'
import { errorMessage } from '@/services/http'
import type { Account } from '@/types/banking'
import { showDemoNotice } from '@/utils/feedback'
import { maskMoney } from '@/utils/money'

const router = useRouter()
const accounts = ref<Account[]>([])
const loading = ref(true)
const loadError = ref('')
const balanceVisible = ref(true)

const totalMinor = computed(() =>
  accounts.value.reduce((total, item) => total + item.balanceMinor, 0),
)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    accounts.value = await bankingApi.getAccounts()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

function openAccount(account: Account): void {
  void router.push({ name: 'account-detail', params: { accountId: account.id } })
}

onMounted(load)
</script>

<template>
  <div class="app-page accounts-page">
    <header class="page-topbar">
      <h1>我的账户</h1>
      <button
        class="page-topbar__action"
        type="button"
        :aria-label="balanceVisible ? '隐藏金额' : '显示金额'"
        @click="balanceVisible = !balanceVisible"
      >
        <VanIcon :name="balanceVisible ? 'eye-o' : 'closed-eye'" size="20" />
      </button>
    </header>

    <div v-if="loading" class="skeleton-stack">
      <VanSkeleton title :row="3" />
      <VanSkeleton title :row="4" />
    </div>

    <section v-else-if="loadError" class="surface-card data-state">
      <div class="data-state__content">
        <VanIcon name="warning-o" size="38" color="#dc4a5d" />
        <h2>账户加载失败</h2>
        <p>{{ loadError }}</p>
        <VanButton type="primary" round @click="load">重新加载</VanButton>
      </div>
    </section>

    <template v-else>
      <section class="account-summary">
        <span>账户总资产</span>
        <strong>{{ maskMoney(balanceVisible, totalMinor) }}</strong>
        <p><VanIcon name="passed" /> 账户状态正常，资金由数字银行模拟系统提供</p>
      </section>

      <section class="section-block">
        <div class="section-heading">
          <div>
            <h2>全部账户</h2>
            <p>共 {{ accounts.length }} 个已绑定账户</p>
          </div>
          <button class="section-heading__action" type="button" @click="showDemoNotice('添加账户')">
            <VanIcon name="plus" /> 添加账户
          </button>
        </div>
        <div class="accounts-grid">
          <AccountCard
            v-for="account in accounts"
            :key="account.id"
            :account="account"
            :balance-visible="balanceVisible"
            @select="openAccount"
          />
        </div>
      </section>

      <section class="account-service surface-card">
        <span class="account-service__icon"><VanIcon name="shield-o" /></span>
        <div>
          <strong>账户安全中心</strong>
          <p>管理限额、设备与交易提醒</p>
        </div>
        <VanIcon name="arrow" />
      </section>
    </template>
  </div>
</template>

<style scoped>
.account-summary {
  position: relative;
  min-height: 174px;
  padding: 25px;
  overflow: hidden;
  border-radius: var(--bank-radius-xl);
  color: #fff;
  background:
    radial-gradient(circle at 88% 0, rgb(51 169 255 / 58%), transparent 12rem),
    linear-gradient(135deg, #071a3d, #0b56bc);
  box-shadow: 0 18px 38px rgb(11 55 131 / 18%);
}

.account-summary::after {
  position: absolute;
  width: 150px;
  height: 150px;
  right: -60px;
  bottom: -80px;
  border: 1px solid rgb(255 255 255 / 20%);
  border-radius: 50%;
  content: '';
}

.account-summary > span {
  color: rgb(255 255 255 / 68%);
  font-size: 13px;
}

.account-summary > strong {
  display: block;
  margin-top: 9px;
  font-size: clamp(29px, 8vw, 42px);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
}

.account-summary p {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 18px 0 0;
  color: rgb(255 255 255 / 65%);
  font-size: 11px;
}

.accounts-grid {
  display: grid;
  min-width: 0;
  gap: 15px;
}

.account-service {
  display: flex;
  align-items: center;
  gap: 13px;
  margin-top: 22px;
  padding: 17px;
}

.account-service__icon {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 14px;
  color: var(--bank-green-600);
  background: #e9f8f2;
  font-size: 21px;
}

.account-service div {
  min-width: 0;
  flex: 1;
}

.account-service strong {
  font-size: 14px;
}

.account-service p {
  margin: 5px 0 0;
  color: var(--bank-ink-500);
  font-size: 12px;
}

.account-service > :deep(.van-icon) {
  color: var(--bank-ink-300);
}

@media (min-width: 580px) {
  .accounts-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 920px) {
  .accounts-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
