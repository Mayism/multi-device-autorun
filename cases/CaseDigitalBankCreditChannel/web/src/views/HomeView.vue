<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Button as VanButton, Icon as VanIcon, Skeleton as VanSkeleton } from 'vant'

import AccountCard from '@/components/AccountCard.vue'
import SectionHeading from '@/components/SectionHeading.vue'
import TransactionItem from '@/components/TransactionItem.vue'
import { bankingApi } from '@/services/banking'
import { errorMessage } from '@/services/http'
import { useNotificationsStore } from '@/stores/notifications'
import type { Dashboard } from '@/types/banking'
import { showDemoNotice } from '@/utils/feedback'
import { formatMoney, maskMoney } from '@/utils/money'

const router = useRouter()
const notifications = useNotificationsStore()
const { unreadCount } = storeToRefs(notifications)
const dashboard = ref<Dashboard | null>(null)
const loading = ref(true)
const refreshing = ref(false)
const loadError = ref('')
const balanceVisible = ref(true)

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

const quickActions = [
  { label: '转账汇款', icon: 'exchange', route: 'transfer', tone: 'blue' },
  { label: '信用卡', icon: 'credit-pay', route: 'cards', tone: 'violet' },
  { label: '收支明细', icon: 'orders-o', route: 'accounts', tone: 'cyan' },
  { label: '稳健理财', icon: 'chart-trending-o', route: 'wealth', tone: 'green' },
]

async function loadDashboard(refresh = false): Promise<void> {
  loadError.value = ''
  if (refresh) refreshing.value = true
  else loading.value = true
  try {
    dashboard.value = await bankingApi.getDashboard()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function navigate(name: string): void {
  void router.push({ name })
}

onMounted(() => {
  void loadDashboard()
  void notifications.load()
})
</script>

<template>
  <div class="home-view">
    <div class="app-page">
      <header class="home-header">
        <div class="brand-lockup">
          <span class="brand-symbol"><span></span></span>
          <div>
            <strong>数字银行</strong>
            <small>安全 · 便捷 · 智能</small>
          </div>
        </div>
        <div class="home-header__actions">
          <button type="button" aria-label="在线客服" @click="showDemoNotice('在线客服')">
            <VanIcon name="service-o" />
          </button>
          <button
            type="button"
            :aria-label="unreadCount ? `消息中心，${unreadCount} 条未读` : '消息中心，无未读消息'"
            @click="navigate('messages')"
          >
            <VanIcon name="bell" :dot="unreadCount > 0" />
          </button>
        </div>
      </header>

      <div v-if="loading" class="skeleton-stack">
        <VanSkeleton title :row="3" />
        <VanSkeleton title :row="5" />
      </div>

      <section v-else-if="loadError" class="surface-card data-state">
        <div class="data-state__content">
          <VanIcon name="replay" size="38" color="#0e6bf6" />
          <h2>暂时无法加载首页</h2>
          <p>{{ loadError }}</p>
          <VanButton type="primary" round @click="loadDashboard()">重新加载</VanButton>
        </div>
      </section>

      <template v-else-if="dashboard">
        <section class="welcome-row">
          <div>
            <p>{{ greeting }}，{{ dashboard.customer.name }}</p>
            <span>今天也要安心管理每一笔财富</span>
          </div>
          <span class="demo-environment"><VanIcon name="shield-o" /> 模拟数据</span>
        </section>

        <section class="asset-hero">
          <div class="asset-hero__glow"></div>
          <div class="asset-hero__top">
            <span>总资产（人民币）</span>
            <button
              type="button"
              :aria-label="balanceVisible ? '隐藏资产金额' : '显示资产金额'"
              @click="balanceVisible = !balanceVisible"
            >
              <VanIcon :name="balanceVisible ? 'eye-o' : 'closed-eye'" />
            </button>
          </div>
          <strong class="asset-hero__amount">
            {{ maskMoney(balanceVisible, dashboard.totalAssetsMinor) }}
          </strong>
          <div class="asset-hero__metrics">
            <div>
              <span>本月收入</span>
              <strong>{{
                balanceVisible ? `+${formatMoney(dashboard.monthIncomeMinor)}` : '••••••'
              }}</strong>
            </div>
            <div>
              <span>本月支出</span>
              <strong>{{
                balanceVisible ? `-${formatMoney(dashboard.monthExpenseMinor)}` : '••••••'
              }}</strong>
            </div>
            <div>
              <span>资产较上月</span>
              <strong class="positive-text">+{{ dashboard.assetChangeRate }}%</strong>
            </div>
          </div>
        </section>

        <section class="quick-grid" aria-label="快捷服务">
          <button
            v-for="action in quickActions"
            :key="action.route"
            class="quick-action"
            type="button"
            @click="navigate(action.route)"
          >
            <span class="quick-action__icon" :class="`quick-action__icon--${action.tone}`">
              <VanIcon :name="action.icon" />
            </span>
            <span>{{ action.label }}</span>
          </button>
        </section>

        <div class="content-grid content-grid--two home-content-grid">
          <div class="home-main-column">
            <section class="section-block">
              <SectionHeading
                title="我的账户"
                action-text="查看全部"
                @action="navigate('accounts')"
              />
              <div class="account-grid">
                <AccountCard
                  v-for="account in dashboard.accounts.slice(0, 2)"
                  :key="account.id"
                  :account="account"
                  :balance-visible="balanceVisible"
                  @select="navigate('accounts')"
                />
              </div>
            </section>

            <section class="section-block">
              <SectionHeading
                title="最近交易"
                description="近 30 天账户变动"
                action-text="全部明细"
                @action="navigate('accounts')"
              />
              <div class="surface-card transaction-list">
                <TransactionItem
                  v-for="transaction in dashboard.recentTransactions"
                  :key="transaction.id"
                  :transaction="transaction"
                />
              </div>
            </section>
          </div>

          <aside class="home-side-column">
            <section class="section-block notice-section">
              <SectionHeading title="贴心提醒" />
              <div class="notice-stack">
                <article
                  v-for="notice in dashboard.notices"
                  :key="notice.id"
                  class="notice-card"
                  :class="`notice-card--${notice.tone}`"
                >
                  <span class="notice-card__icon">
                    <VanIcon :name="notice.tone === 'green' ? 'clock-o' : 'shield-o'" />
                  </span>
                  <div>
                    <strong>{{ notice.title }}</strong>
                    <p>{{ notice.description }}</p>
                  </div>
                </article>
              </div>
            </section>

            <section class="wealth-promo">
              <span>财富精选</span>
              <h2>闲钱也能稳稳向前</h2>
              <p>根据您的平衡型风险偏好，为您展示适配的模拟产品。</p>
              <button type="button" @click="navigate('wealth')">
                查看方案 <VanIcon name="arrow" />
              </button>
            </section>
          </aside>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.home-view {
  min-height: 100%;
}

.home-header {
  display: flex;
  min-height: 76px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: max(12px, env(safe-area-inset-top));
}

.brand-lockup {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 11px;
}

.brand-symbol {
  display: grid;
  width: 39px;
  height: 39px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 13px;
  background: linear-gradient(145deg, #3596ff, #0753da);
  box-shadow: 0 8px 20px rgb(14 107 246 / 20%);
}

.brand-symbol::before,
.brand-symbol span,
.brand-symbol span::after {
  display: block;
  width: 18px;
  height: 4px;
  border-radius: 999px;
  background: #fff;
  content: '';
}

.brand-symbol::before {
  transform: translateY(-5px);
}

.brand-symbol span::after {
  width: 12px;
  transform: translate(6px, 5px);
}

.brand-lockup div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.brand-lockup strong {
  font-size: 17px;
  letter-spacing: 0.02em;
}

.brand-lockup small {
  color: var(--bank-ink-500);
  font-size: 10px;
  letter-spacing: 0.07em;
}

.home-header__actions {
  display: flex;
  gap: 8px;
}

.home-header__actions button {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  padding: 0;
  border: 1px solid var(--bank-line);
  border-radius: 14px;
  color: var(--bank-ink-700);
  background: rgb(255 255 255 / 80%);
  box-shadow: 0 6px 16px rgb(24 52 92 / 5%);
  font-size: 19px;
  cursor: pointer;
}

.welcome-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 15px;
  padding: 15px 2px 16px;
}

.welcome-row p {
  margin: 0;
  font-size: clamp(22px, 5vw, 31px);
  font-weight: 780;
  letter-spacing: -0.04em;
}

.welcome-row > div > span {
  display: block;
  margin-top: 6px;
  color: var(--bank-ink-500);
  font-size: 13px;
}

.demo-environment {
  display: none;
  min-height: 30px;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid #dce8fb;
  border-radius: 999px;
  color: var(--bank-blue-700);
  background: #f5f9ff;
  font-size: 12px;
}

.asset-hero {
  position: relative;
  min-height: 226px;
  padding: clamp(22px, 5vw, 34px);
  overflow: hidden;
  border-radius: var(--bank-radius-xl);
  color: #fff;
  background:
    radial-gradient(circle at 88% 14%, rgb(61 177 255 / 58%), transparent 13rem),
    linear-gradient(135deg, #071a3d 0%, #0c397a 55%, #0a67dd 100%);
  box-shadow: 0 22px 42px rgb(11 55 131 / 20%);
}

.asset-hero::after {
  position: absolute;
  width: 190px;
  height: 190px;
  right: -75px;
  bottom: -110px;
  border: 1px solid rgb(255 255 255 / 17%);
  border-radius: 50%;
  box-shadow: 0 0 0 35px rgb(255 255 255 / 3%);
  content: '';
}

.asset-hero__top {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 9px;
  color: rgb(255 255 255 / 72%);
  font-size: 13px;
}

.asset-hero__top button {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  padding: 0;
  border: 0;
  color: rgb(255 255 255 / 72%);
  background: transparent;
  cursor: pointer;
}

.asset-hero__amount {
  position: relative;
  z-index: 1;
  display: block;
  max-width: 100%;
  margin-top: 8px;
  overflow: hidden;
  font-size: clamp(30px, 8vw, 48px);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-hero__metrics {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 15px;
  margin-top: 28px;
  padding-top: 19px;
  border-top: 1px solid rgb(255 255 255 / 15%);
}

.asset-hero__metrics div:last-child {
  display: none;
}

.asset-hero__metrics div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.asset-hero__metrics span {
  color: rgb(255 255 255 / 62%);
  font-size: 11px;
}

.asset-hero__metrics strong {
  overflow: hidden;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-hero__metrics .positive-text {
  color: #82f4c5;
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 18px;
  padding: 16px 8px;
  border: 1px solid rgb(224 231 242 / 84%);
  border-radius: var(--bank-radius-lg);
  background: var(--bank-surface);
  box-shadow: var(--bank-shadow-soft);
}

.quick-action {
  display: flex;
  min-width: 0;
  min-height: 76px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 4px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  cursor: pointer;
}

.quick-action:active {
  background: var(--bank-surface-soft);
}

.quick-action > span:last-child {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-action__icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 14px;
  font-size: 20px;
}

.quick-action__icon--blue {
  color: var(--bank-blue-700);
  background: #eaf2ff;
}

.quick-action__icon--violet {
  color: #6e50dc;
  background: #f0edff;
}

.quick-action__icon--cyan {
  color: #078c98;
  background: #e7f8f9;
}

.quick-action__icon--green {
  color: var(--bank-green-600);
  background: #e9f8f2;
}

.account-grid {
  display: grid;
  min-width: 0;
  gap: 14px;
}

.transaction-list {
  padding: 0 18px;
}

.notice-section {
  margin-top: clamp(22px, 4vw, 34px);
}

.notice-stack {
  display: grid;
  gap: 12px;
}

.notice-card {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 12px;
  padding: 17px;
  border: 1px solid #dfeafa;
  border-radius: var(--bank-radius-md);
  background: linear-gradient(145deg, #f9fbff, #eef5ff);
}

.notice-card--green {
  border-color: #d9eee7;
  background: linear-gradient(145deg, #fbfffd, #ecf9f4);
}

.notice-card__icon {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 12px;
  color: var(--bank-blue-700);
  background: #fff;
  box-shadow: 0 5px 14px rgb(21 66 137 / 8%);
  font-size: 17px;
}

.notice-card--green .notice-card__icon {
  color: var(--bank-green-600);
}

.notice-card strong {
  font-size: 14px;
}

.notice-card p {
  margin: 5px 0 0;
  color: var(--bank-ink-500);
  font-size: 12px;
  line-height: 1.6;
}

.wealth-promo {
  position: relative;
  margin-top: 16px;
  padding: 23px;
  overflow: hidden;
  border-radius: var(--bank-radius-lg);
  color: #fff;
  background: linear-gradient(145deg, #087e88, #0e495f);
  box-shadow: 0 14px 30px rgb(10 92 105 / 17%);
}

.wealth-promo::after {
  position: absolute;
  width: 120px;
  height: 120px;
  top: -52px;
  right: -44px;
  border: 22px solid rgb(255 255 255 / 5%);
  border-radius: 50%;
  content: '';
}

.wealth-promo > span {
  color: #a8f3e4;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.08em;
}

.wealth-promo h2 {
  margin: 13px 0 8px;
  font-size: 21px;
}

.wealth-promo p {
  margin: 0;
  color: rgb(255 255 255 / 68%);
  font-size: 12px;
  line-height: 1.65;
}

.wealth-promo button {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: 5px;
  margin-top: 14px;
  padding: 0;
  border: 0;
  color: #fff;
  background: transparent;
  font-size: 13px;
  font-weight: 680;
  cursor: pointer;
}

@media (min-width: 520px) {
  .demo-environment {
    display: inline-flex;
  }

  .asset-hero__metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .asset-hero__metrics div:last-child {
    display: flex;
  }

  .quick-grid {
    padding: 18px;
  }

  .account-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 720px) {
  .home-header {
    min-height: 88px;
  }

  .asset-hero {
    min-height: 252px;
  }

  .home-content-grid {
    margin-top: 2px;
  }

  .notice-section {
    margin-top: clamp(22px, 4vw, 34px);
  }
}
</style>
