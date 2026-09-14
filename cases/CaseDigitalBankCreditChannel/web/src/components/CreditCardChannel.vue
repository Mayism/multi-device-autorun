<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button as VanButton, Icon as VanIcon, Progress as VanProgress } from 'vant'

import { useChannelRem } from '@/composables/useChannelRem'
import type { CreditCard } from '@/types/banking'
import { showDemoNotice } from '@/utils/feedback'
import { formatMoney } from '@/utils/money'

const props = defineProps<{ cards: CreditCard[] }>()
const emit = defineEmits<{ repay: [card: CreditCard, amountMinor?: number] }>()
const container = ref<HTMLElement | null>(null)
const activeCardId = ref('')
const activeCard = computed(
  () => props.cards.find((card) => card.id === activeCardId.value) ?? props.cards[0],
)
const usagePercent = computed(() => {
  const card = activeCard.value
  return card
    ? Math.min(100, Math.round(((card.limitMinor - card.availableMinor) / card.limitMinor) * 100))
    : 0
})
const services = [
  { name: '账单明细', icon: 'orders-o' },
  { name: '额度管理', icon: 'balance-o' },
  { name: '卡片安全', icon: 'shield-o' },
  { name: '用卡权益', icon: 'gift-o' },
]

useChannelRem(container)
</script>

<template>
  <div ref="container" class="credit-card-grid credit-channel">
    <template v-if="activeCard">
      <div class="channel-welcome channel-module">
        <div>
          <span class="channel-eyebrow">CREDIT / 每一份精彩</span>
          <h2>用卡有度，生活从容</h2>
        </div>
        <button
          class="channel-add"
          type="button"
          aria-label="申请新卡"
          @click="showDemoNotice('信用卡申请')"
        >
          <VanIcon name="plus" />
        </button>
      </div>

      <div class="channel-tabs channel-module" role="tablist" aria-label="我的信用卡">
        <button
          v-for="card in cards"
          :id="`channel-tab-${card.id}`"
          :key="card.id"
          type="button"
          role="tab"
          aria-controls="channel-card-panel"
          :aria-selected="activeCard.id === card.id"
          :class="{ 'is-active': activeCard.id === card.id }"
          @click="activeCardId = card.id"
        >
          <span>{{ card.name }}</span>
          <small>尾号 {{ card.maskedNumber.slice(-4) }}</small>
        </button>
      </div>

      <section
        id="channel-card-panel"
        class="channel-module"
        role="tabpanel"
        :aria-labelledby="`channel-tab-${activeCard.id}`"
      >
        <article class="channel-card" :class="`channel-card--${activeCard.accent}`">
          <div class="channel-card__top"><span>数字银行</span><VanIcon name="certificate" /></div>
          <div class="channel-card__identity">
            <strong>{{ activeCard.name }}</strong>
            <span>{{ activeCard.maskedNumber }}</span>
          </div>
          <div class="channel-card__footer"><span>DIGITAL BANK</span><span>CREDIT</span></div>
        </article>

        <div class="channel-bill">
          <div class="channel-section-title">
            <h3>本期账单</h3>
            <span class="channel-due"
              >{{ activeCard.dueDate.slice(5).replace('-', '月') }}日到期</span
            >
          </div>
          <div class="channel-metrics">
            <div>
              <span>本期应还（元）</span><strong>{{ formatMoney(activeCard.billMinor) }}</strong>
            </div>
            <div>
              <span>可用额度（元）</span
              ><strong class="channel-metrics__available">{{
                formatMoney(activeCard.availableMinor)
              }}</strong>
            </div>
          </div>
          <div class="channel-usage">
            <span>额度使用 {{ usagePercent }}%</span>
            <span>总额度 {{ formatMoney(activeCard.limitMinor) }}</span>
          </div>
          <VanProgress
            :percentage="usagePercent"
            :show-pivot="false"
            stroke-width="5"
            color="#0e6bf6"
          />
          <div class="channel-bill-actions">
            <VanButton round @click="emit('repay', activeCard, activeCard.minimumPaymentMinor)"
              >最低还款</VanButton
            >
            <VanButton type="primary" round @click="emit('repay', activeCard)">立即还款</VanButton>
          </div>
        </div>
      </section>

      <section class="channel-services channel-module" aria-label="卡片服务">
        <button
          v-for="service in services"
          :key="service.name"
          type="button"
          @click="showDemoNotice(service.name)"
        >
          <span><VanIcon :name="service.icon" /></span>
          {{ service.name }}
        </button>
      </section>

      <section class="channel-module" aria-labelledby="channel-benefits-title">
        <div class="channel-section-title channel-benefits-title">
          <h3 id="channel-benefits-title">为你精选</h3>
          <span>让日常多一点惊喜</span>
        </div>
        <div class="channel-benefits">
          <button
            class="channel-benefit channel-benefit--travel"
            type="button"
            @click="showDemoNotice('出行礼遇')"
          >
            <span class="channel-benefit__tag">出行礼遇</span>
            <strong>下一站，去看看</strong>
            <span>精选出行权益</span>
            <VanIcon name="guide-o" />
          </button>
          <button
            class="channel-benefit channel-benefit--gift"
            type="button"
            @click="showDemoNotice('积分好礼')"
          >
            <span class="channel-benefit__tag">积分好礼</span>
            <strong>把积分变成心意</strong>
            <span>发现生活小确幸</span>
            <VanIcon name="gift-o" />
          </button>
        </div>
      </section>
      <p class="channel-note">账单与权益为演示数据，不产生真实扣款。</p>
    </template>
    <section v-else class="channel-empty channel-module surface-card">
      <VanIcon name="credit-pay" size="40" />
      <h2>暂无绑定信用卡</h2>
      <p>添加卡片后，可查看账单与用卡权益。</p>
      <VanButton type="primary" round @click="showDemoNotice('信用卡申请')">申请新卡</VanButton>
    </section>
  </div>
</template>

<style scoped>
.credit-channel {
  width: min(100%, 720px);
  min-width: 0;
  margin: 0 auto;
  padding: 4px 0 12px;
}

.channel-module {
  width: 9.2rem;
  margin: 0.36rem 0.4rem 0;
}

.channel-welcome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.2rem;
  margin-top: 0;
  margin-bottom: 0.44rem;
}

.channel-eyebrow {
  color: var(--bank-blue-700);
  font-size: clamp(10px, 0.28rem, 15px);
  font-weight: 700;
  letter-spacing: 0.06em;
}

.channel-welcome h2 {
  margin: 0.18rem 0 0;
  font-size: clamp(19px, 0.56rem, 32px);
  letter-spacing: -0.03em;
}

.channel-add {
  display: grid;
  width: 1.12rem;
  min-width: 44px;
  height: 1.12rem;
  min-height: 44px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid #dce7f7;
  border-radius: 50%;
  color: var(--bank-blue-700);
  background: #fff;
  font-size: clamp(20px, 0.54rem, 32px);
  cursor: pointer;
}

.channel-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem;
}

.channel-tabs button {
  display: flex;
  width: 4.5rem;
  min-height: 48px;
  flex: 0 0 4.5rem;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 0.24rem 0.3rem;
  border: 1px solid transparent;
  border-radius: 0.24rem;
  color: var(--bank-ink-500);
  background: #eaf0f8;
  text-align: left;
  cursor: pointer;
}

.channel-tabs button span {
  font-size: clamp(12px, 0.35rem, 21px);
  font-weight: 700;
}

.channel-tabs button small {
  font-size: clamp(10px, 0.28rem, 15px);
}

.channel-tabs .is-active {
  border-color: #9dc1f9;
  color: var(--bank-blue-700);
  background: #fff;
  box-shadow: 0 4px 12px rgb(24 86 178 / 7%);
}

.channel-card {
  position: relative;
  display: flex;
  width: 9.2rem;
  min-height: 4.5rem;
  flex-direction: column;
  padding: 0.5rem;
  overflow: hidden;
  border-radius: 0.38rem;
  color: #fff;
  box-shadow: 0 12px 24px rgb(7 35 83 / 14%);
}

.channel-card::after {
  position: absolute;
  width: 4rem;
  height: 4rem;
  right: -1.6rem;
  bottom: -2rem;
  border: 1px solid rgb(255 255 255 / 22%);
  border-radius: 50%;
  box-shadow:
    0 0 0 0.65rem rgb(255 255 255 / 4%),
    0 0 0 1.3rem rgb(255 255 255 / 3%);
  content: '';
  pointer-events: none;
}

.channel-card--midnight {
  background:
    radial-gradient(ellipse at 90% 10%, #246eb5, transparent 70%),
    linear-gradient(130deg, #06142f, #12386d);
}

.channel-card--aurora {
  background:
    radial-gradient(ellipse at 90% 10%, #389c9a, transparent 70%),
    linear-gradient(130deg, #0c364a, #17656e);
}

.channel-card__top,
.channel-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.channel-card__top {
  font-size: clamp(13px, 0.38rem, 24px);
  font-weight: 650;
}

.channel-card__top .van-icon {
  font-size: 0.64rem;
}

.channel-card__identity {
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
  margin-top: 0.56rem;
}

.channel-card__identity strong {
  font-size: clamp(17px, 0.5rem, 30px);
}

.channel-card__identity > span {
  color: rgb(255 255 255 / 78%);
  font-size: clamp(13px, 0.38rem, 22px);
  letter-spacing: 0.13em;
}

.channel-card__footer {
  margin-top: auto;
  padding-top: 0.45rem;
  color: rgb(255 255 255 / 62%);
  font-size: clamp(9px, 0.24rem, 14px);
  letter-spacing: 0.15em;
}

.channel-bill {
  width: 9.2rem;
  margin-top: 0.28rem;
  padding: 0.4rem;
  border-radius: 0.32rem;
  background: #fff;
  box-shadow: var(--bank-shadow-soft);
}

.channel-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.2rem;
}

.channel-section-title h3 {
  margin: 0;
  font-size: clamp(15px, 0.42rem, 25px);
}

.channel-due {
  padding: 0.12rem 0.2rem;
  border-radius: 20px;
  color: #986012;
  background: #fff6e7;
  font-size: clamp(10px, 0.28rem, 16px);
}

.channel-metrics {
  display: grid;
  grid-template-columns: repeat(2, 4.1rem);
  gap: 0.2rem;
  margin-top: 0.48rem;
}

.channel-metrics > div {
  display: flex;
  flex-direction: column;
  gap: 0.16rem;
}

.channel-metrics span {
  color: var(--bank-ink-500);
  font-size: clamp(11px, 0.31rem, 17px);
}

.channel-metrics strong {
  font-size: clamp(20px, 0.64rem, 38px);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
}

.channel-metrics .channel-metrics__available {
  font-size: clamp(18px, 0.55rem, 33px);
}

.channel-usage {
  display: flex;
  justify-content: space-between;
  gap: 0.12rem;
  margin: 0.4rem 0 0.2rem;
  color: var(--bank-ink-500);
  font-size: clamp(10px, 0.28rem, 16px);
}

.channel-bill-actions {
  display: grid;
  grid-template-columns: repeat(2, 4.1rem);
  gap: 0.2rem;
  margin-top: 0.38rem;
}

.channel-bill-actions .van-button {
  height: 1.12rem;
  min-height: 46px;
  font-size: clamp(12px, 0.35rem, 20px);
}

.channel-services {
  display: grid;
  grid-template-columns: repeat(4, 2.2rem);
  padding: 0.3rem 0.2rem;
  border-radius: 0.32rem;
  background: #fff;
  box-shadow: var(--bank-shadow-soft);
}

.channel-services button {
  display: flex;
  min-height: 64px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.2rem;
  padding: 0.1rem 0;
  border: 0;
  background: transparent;
  font-size: clamp(11px, 0.31rem, 18px);
  cursor: pointer;
}

.channel-services button > span {
  display: grid;
  width: 1rem;
  height: 1rem;
  place-items: center;
  border-radius: 0.3rem;
  color: var(--bank-blue-700);
  background: #edf4ff;
  font-size: 0.52rem;
}

.channel-benefits-title {
  margin-bottom: 0.28rem;
}

.channel-benefits-title > span {
  color: var(--bank-ink-500);
  font-size: clamp(10px, 0.28rem, 16px);
}

.channel-benefits {
  display: grid;
  width: 9.2rem;
  grid-template-columns: repeat(2, 4.5rem);
  gap: 0.2rem;
}

.channel-benefit {
  position: relative;
  display: flex;
  min-height: 3.24rem;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.16rem;
  padding: 0.35rem;
  overflow: hidden;
  border: 0;
  border-radius: 0.32rem;
  text-align: left;
  cursor: pointer;
}

.channel-benefit--travel {
  color: #164c80;
  background: linear-gradient(135deg, #e4f2ff, #d4e9f9);
}

.channel-benefit--gift {
  color: #775028;
  background: linear-gradient(135deg, #fff5df, #f2e4ca);
}

.channel-benefit__tag {
  font-size: clamp(10px, 0.27rem, 15px);
}

.channel-benefit strong {
  font-size: clamp(12px, 0.37rem, 23px);
}

.channel-benefit > span:not(.channel-benefit__tag) {
  font-size: clamp(10px, 0.27rem, 15px);
  opacity: 0.75;
}

.channel-benefit > .van-icon {
  align-self: flex-end;
  margin-top: auto;
  padding-top: 0.15rem;
  font-size: 0.9rem;
  opacity: 0.65;
}

.channel-note {
  margin: 0.5rem 0 0;
  color: var(--bank-ink-500);
  font-size: 11px;
  text-align: center;
}

.channel-empty {
  padding: 0.7rem 0.4rem;
  text-align: center;
}

.channel-empty h2 {
  font-size: 20px;
}

.channel-empty p {
  font-size: 13px;
}
</style>
