<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Button as VanButton, Icon as VanIcon, Skeleton as VanSkeleton } from 'vant'

import SectionHeading from '@/components/SectionHeading.vue'
import { bankingApi } from '@/services/banking'
import { errorMessage } from '@/services/http'
import type { WealthOverview, WealthProduct } from '@/types/banking'
import { showDemoNotice } from '@/utils/feedback'
import { formatMoney } from '@/utils/money'

const overview = ref<WealthOverview | null>(null)
const loading = ref(true)
const loadError = ref('')

const featuredProducts = computed(
  () => overview.value?.products.filter((item) => item.featured) ?? [],
)

function riskTone(product: WealthProduct): string {
  if (product.riskLevel === 'R1') return 'green'
  if (product.riskLevel === 'R2') return 'blue'
  return 'amber'
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    overview.value = await bankingApi.getWealthOverview()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="app-page wealth-page">
    <header class="page-topbar">
      <h1>财富</h1>
      <button class="page-topbar__action" type="button" @click="showDemoNotice('投顾服务')">
        <VanIcon name="service-o" /> 投顾服务
      </button>
    </header>

    <div v-if="loading" class="skeleton-stack">
      <VanSkeleton title :row="4" />
      <VanSkeleton title :row="6" />
    </div>

    <section v-else-if="loadError" class="surface-card data-state">
      <div class="data-state__content">
        <VanIcon name="warning-o" size="38" color="#dc4a5d" />
        <h2>财富数据暂不可用</h2>
        <p>{{ loadError }}</p>
        <VanButton type="primary" round @click="load">重新加载</VanButton>
      </div>
    </section>

    <template v-else-if="overview">
      <section class="wealth-hero">
        <div class="wealth-hero__head">
          <div>
            <span>持仓总市值</span>
            <strong>{{ formatMoney(overview.totalHoldingMinor) }}</strong>
          </div>
          <span class="wealth-hero__risk"><VanIcon name="passed" /> 平衡型</span>
        </div>
        <div class="wealth-hero__profit">
          <span>累计收益</span>
          <strong>+{{ formatMoney(overview.totalProfitMinor) }}</strong>
        </div>
        <div class="wealth-hero__actions">
          <button type="button" @click="showDemoNotice('我的持仓')">
            <VanIcon name="balance-list-o" /> 我的持仓
          </button>
          <button type="button" @click="showDemoNotice('收益分析')">
            <VanIcon name="chart-trending-o" /> 收益分析
          </button>
          <button type="button" @click="showDemoNotice('财富交易记录')">
            <VanIcon name="notes-o" /> 交易记录
          </button>
        </div>
      </section>

      <section class="section-block">
        <SectionHeading
          title="持仓概览"
          description="数据更新于今日 15:00"
          action-text="查看全部"
          @action="showDemoNotice('全部持仓')"
        />
        <div class="holding-grid">
          <article
            v-for="holding in overview.holdings"
            :key="holding.id"
            class="holding-card surface-card"
          >
            <span class="holding-card__icon"><VanIcon name="gold-coin-o" /></span>
            <div class="holding-card__main">
              <strong>{{ holding.productName }}</strong>
              <span>当前市值</span>
              <b>{{ formatMoney(holding.marketValueMinor) }}</b>
            </div>
            <div class="holding-card__profit">
              <span>累计收益</span>
              <strong>+{{ formatMoney(holding.profitMinor) }}</strong>
            </div>
          </article>
        </div>
      </section>

      <section class="section-block">
        <SectionHeading
          title="为您优选"
          description="基于您的风险等级展示模拟产品"
          action-text="更多产品"
          @action="showDemoNotice('更多财富产品')"
        />
        <div class="product-grid">
          <article
            v-for="product in featuredProducts"
            :key="product.id"
            class="product-card surface-card"
          >
            <header>
              <span class="status-chip" :class="`status-chip--${riskTone(product)}`">{{
                product.riskLevel
              }}</span>
              <span>{{ product.category }}</span>
            </header>
            <h3>{{ product.name }}</h3>
            <div class="product-card__yield">
              <div>
                <strong>{{ product.annualRateText }}</strong
                ><span>业绩比较基准</span>
              </div>
              <div>
                <strong>{{ product.periodText }}</strong
                ><span>持有期限</span>
              </div>
            </div>
            <footer>
              <span>{{ formatMoney(product.minimumMinor) }} 起购</span>
              <VanButton size="small" type="primary" round @click="showDemoNotice(product.name)">
                查看详情
              </VanButton>
            </footer>
          </article>
        </div>
      </section>

      <section class="wealth-disclaimer">
        <VanIcon name="info-o" />
        <p>以上产品及收益率均为模板演示数据，不构成投资建议。理财非存款，投资需谨慎。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.wealth-hero {
  position: relative;
  padding: clamp(22px, 5vw, 32px);
  overflow: hidden;
  border-radius: var(--bank-radius-xl);
  color: #fff;
  background:
    radial-gradient(circle at 88% 10%, rgb(74 227 199 / 30%), transparent 13rem),
    linear-gradient(140deg, #07363f, #08606a 58%, #087c75);
  box-shadow: 0 20px 40px rgb(7 97 100 / 19%);
}

.wealth-hero::after {
  position: absolute;
  width: 170px;
  height: 170px;
  right: -72px;
  bottom: -93px;
  border: 1px solid rgb(255 255 255 / 18%);
  border-radius: 50%;
  box-shadow: 0 0 0 35px rgb(255 255 255 / 3%);
  content: '';
}

.wealth-hero__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.wealth-hero__head > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
}

.wealth-hero__head span,
.wealth-hero__profit span {
  color: rgb(255 255 255 / 68%);
  font-size: 12px;
}

.wealth-hero__head strong {
  font-size: clamp(30px, 8vw, 44px);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
}

.wealth-hero__risk {
  display: inline-flex;
  min-height: 30px;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid rgb(255 255 255 / 20%);
  border-radius: 999px;
  color: #baf9e8 !important;
  background: rgb(255 255 255 / 8%);
}

.wealth-hero__profit {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 17px;
}

.wealth-hero__profit strong {
  color: #b6f6df;
  font-size: 15px;
}

.wealth-hero__actions {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid rgb(255 255 255 / 14%);
}

.wealth-hero__actions button {
  display: flex;
  min-width: 0;
  min-height: 48px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px;
  border: 0;
  border-radius: 12px;
  color: rgb(255 255 255 / 83%);
  background: rgb(255 255 255 / 6%);
  font-size: 11px;
  cursor: pointer;
}

.wealth-hero__actions button :deep(.van-icon) {
  font-size: 18px;
}

.holding-grid,
.product-grid {
  display: grid;
  min-width: 0;
  gap: 13px;
}

.holding-card {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 13px;
  padding: 18px;
}

.holding-card__icon {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 14px;
  color: var(--bank-amber-600);
  background: #fff4dc;
  font-size: 21px;
}

.holding-card__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.holding-card__main strong {
  overflow: hidden;
  margin-bottom: 10px;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.holding-card__main span,
.holding-card__profit span {
  color: var(--bank-ink-500);
  font-size: 10px;
}

.holding-card__main b {
  margin-top: 4px;
  font-size: 15px;
}

.holding-card__profit {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
}

.holding-card__profit strong {
  color: var(--bank-green-600);
  font-size: 14px;
}

.product-card {
  padding: 20px;
}

.product-card header {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--bank-ink-500);
  font-size: 11px;
}

.product-card h3 {
  margin: 16px 0 19px;
  font-size: 18px;
}

.product-card__yield {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.product-card__yield div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.product-card__yield strong {
  overflow: hidden;
  color: var(--bank-red-600);
  font-size: 24px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-card__yield div:last-child strong {
  color: var(--bank-ink-900);
  font-size: 17px;
}

.product-card__yield span,
.product-card footer > span {
  color: var(--bank-ink-500);
  font-size: 10px;
}

.product-card footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--bank-line);
}

.wealth-disclaimer {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 22px;
  padding: 0 5px;
  color: var(--bank-ink-500);
  font-size: 11px;
  line-height: 1.65;
}

.wealth-disclaimer p {
  margin: 0;
}

.wealth-disclaimer :deep(.van-icon) {
  flex: 0 0 auto;
  margin-top: 2px;
}

@media (min-width: 680px) {
  .holding-grid,
  .product-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
