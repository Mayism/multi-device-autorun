<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ActionSheet as VanActionSheet,
  Button as VanButton,
  Field as VanField,
  Form as VanForm,
  Icon as VanIcon,
  Skeleton as VanSkeleton,
  showConfirmDialog,
} from 'vant'
import { z } from 'zod'

import { bankingApi } from '@/services/banking'
import { errorMessage } from '@/services/http'
import type { Account, Beneficiary, TransferReceipt } from '@/types/banking'
import { showDemoNotice } from '@/utils/feedback'
import { formatMoney, parseYuanToMinor } from '@/utils/money'

const router = useRouter()
const accounts = ref<Account[]>([])
const beneficiaries = ref<Beneficiary[]>([])
const loading = ref(true)
const submitting = ref(false)
const loadError = ref('')
const formError = ref('')
const showAccountSheet = ref(false)
const showBeneficiarySheet = ref(false)
const fromAccountId = ref('')
const beneficiaryId = ref('')
const amountText = ref('')
const remark = ref('')
const receipt = ref<TransferReceipt | null>(null)

const formSchema = z.object({
  fromAccountId: z.string().min(1, '请选择付款账户'),
  beneficiaryId: z.string().min(1, '请选择收款人'),
  amountText: z.string().min(1, '请输入转账金额'),
  remark: z.string().max(20, '转账附言最多 20 个字'),
})

const availableAccounts = computed(() =>
  accounts.value.filter((account) => account.availableMinor > 0),
)
const selectedAccount = computed(() =>
  accounts.value.find((item) => item.id === fromAccountId.value),
)
const selectedBeneficiary = computed(() =>
  beneficiaries.value.find((item) => item.id === beneficiaryId.value),
)
const accountActions = computed(() =>
  availableAccounts.value.map((account) => ({
    name: `${account.name}  ${account.maskedNumber}`,
    subname: `可用 ${formatMoney(account.availableMinor)}`,
    value: account.id,
  })),
)
const beneficiaryActions = computed(() =>
  beneficiaries.value.map((beneficiary) => ({
    name: beneficiary.name,
    subname: `${beneficiary.bankName}  ${beneficiary.maskedNumber}`,
    value: beneficiary.id,
  })),
)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const [accountResult, beneficiaryResult] = await Promise.all([
      bankingApi.getAccounts(),
      bankingApi.getBeneficiaries(),
    ])
    accounts.value = accountResult
    beneficiaries.value = beneficiaryResult
    fromAccountId.value =
      accountResult.find((item) => item.primary && item.availableMinor > 0)?.id ?? ''
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

function selectAccount(action: { value: string }): void {
  fromAccountId.value = action.value
  showAccountSheet.value = false
}

function selectBeneficiary(action: { value: string }): void {
  beneficiaryId.value = action.value
  showBeneficiarySheet.value = false
}

async function submit(): Promise<void> {
  formError.value = ''
  const parsed = formSchema.safeParse({
    fromAccountId: fromAccountId.value,
    beneficiaryId: beneficiaryId.value,
    amountText: amountText.value,
    remark: remark.value,
  })
  if (!parsed.success) {
    formError.value = parsed.error.issues[0]?.message ?? '请检查转账信息'
    return
  }

  const amountMinor = parseYuanToMinor(parsed.data.amountText)
  if (amountMinor === null || amountMinor <= 0) {
    formError.value = '请输入有效的转账金额，最多保留两位小数'
    return
  }
  if (selectedAccount.value && amountMinor > selectedAccount.value.availableMinor) {
    formError.value = '转账金额不能超过账户可用余额'
    return
  }

  try {
    await showConfirmDialog({
      title: '确认转账',
      message: `向 ${selectedBeneficiary.value?.name ?? ''} 转账 ${formatMoney(amountMinor)}，确认继续吗？`,
      confirmButtonText: '确认转账',
      cancelButtonText: '再检查一下',
    })
  } catch {
    return
  }

  submitting.value = true
  try {
    receipt.value = await bankingApi.createTransfer({
      fromAccountId: parsed.data.fromAccountId,
      beneficiaryId: parsed.data.beneficiaryId,
      amountMinor,
      remark: parsed.data.remark || undefined,
    })
  } catch (error) {
    formError.value = errorMessage(error)
  } finally {
    submitting.value = false
  }
}

function startAnotherTransfer(): void {
  beneficiaryId.value = ''
  amountText.value = ''
  remark.value = ''
  receipt.value = null
}

onMounted(load)
</script>

<template>
  <div class="app-page transfer-page">
    <header class="page-topbar">
      <div class="page-topbar__left">
        <button class="page-topbar__back" type="button" aria-label="返回" @click="router.back()">
          <VanIcon name="arrow-left" size="20" />
        </button>
        <h1>转账汇款</h1>
      </div>
      <button class="page-topbar__action" type="button" @click="showDemoNotice('转账记录')">
        转账记录
      </button>
    </header>

    <div v-if="loading" class="skeleton-stack">
      <VanSkeleton title :row="7" />
    </div>

    <section v-else-if="loadError" class="surface-card data-state">
      <div class="data-state__content">
        <VanIcon name="warning-o" size="38" color="#dc4a5d" />
        <h2>转账服务暂不可用</h2>
        <p>{{ loadError }}</p>
        <VanButton type="primary" round @click="load">重新加载</VanButton>
      </div>
    </section>

    <section v-else-if="receipt" class="receipt-card surface-card">
      <div class="receipt-card__success"><VanIcon name="checked" /></div>
      <span class="receipt-card__eyebrow">转账成功</span>
      <strong class="receipt-card__amount">{{ formatMoney(receipt.amountMinor) }}</strong>
      <p>款项已从付款账户扣除</p>

      <dl class="receipt-card__details">
        <div>
          <dt>收款人</dt>
          <dd>{{ receipt.beneficiaryName }}</dd>
        </div>
        <div>
          <dt>收款银行</dt>
          <dd>{{ receipt.bankName }}</dd>
        </div>
        <div>
          <dt>付款账户</dt>
          <dd>{{ receipt.fromAccountName }}</dd>
        </div>
        <div>
          <dt>手续费</dt>
          <dd>{{ formatMoney(receipt.feeMinor) }}</dd>
        </div>
        <div>
          <dt>业务编号</dt>
          <dd>{{ receipt.referenceNumber }}</dd>
        </div>
      </dl>

      <div class="receipt-card__actions">
        <VanButton block round @click="startAnotherTransfer">再转一笔</VanButton>
        <VanButton type="primary" block round @click="router.replace({ name: 'home' })"
          >完成</VanButton
        >
      </div>
    </section>

    <div v-else class="content-grid content-grid--two transfer-grid">
      <section class="surface-card transfer-form-card">
        <header>
          <span class="transfer-form-card__icon"><VanIcon name="exchange" /></span>
          <div>
            <h2>境内转账</h2>
            <p>预计实时到账，免收手续费</p>
          </div>
        </header>

        <VanForm class="transfer-form" @submit="submit">
          <VanField
            :model-value="
              selectedAccount ? `${selectedAccount.name}  ${selectedAccount.maskedNumber}` : ''
            "
            name="fromAccount"
            label="付款账户"
            placeholder="请选择付款账户"
            readonly
            is-link
            @click="showAccountSheet = true"
          />
          <p v-if="selectedAccount" class="field-assist">
            可用余额 {{ formatMoney(selectedAccount.availableMinor) }}
          </p>

          <VanField
            :model-value="selectedBeneficiary?.name ?? ''"
            name="beneficiary"
            label="收款人"
            placeholder="请选择常用收款人"
            readonly
            is-link
            @click="showBeneficiarySheet = true"
          />
          <p v-if="selectedBeneficiary" class="field-assist">
            {{ selectedBeneficiary.bankName }} · {{ selectedBeneficiary.maskedNumber }}
          </p>

          <div class="amount-field">
            <label for="transfer-amount">转账金额</label>
            <div>
              <span>¥</span>
              <input
                id="transfer-amount"
                v-model="amountText"
                inputmode="decimal"
                autocomplete="off"
                placeholder="0.00"
              />
            </div>
          </div>

          <VanField
            v-model="remark"
            name="remark"
            label="转账附言"
            maxlength="20"
            placeholder="选填，最多 20 个字"
            show-word-limit
          />

          <p v-if="formError" class="form-error" role="alert">
            <VanIcon name="warning-o" /> {{ formError }}
          </p>

          <VanButton
            class="transfer-submit"
            native-type="submit"
            type="primary"
            block
            round
            :loading="submitting"
            loading-text="正在提交"
          >
            下一步
          </VanButton>
        </VanForm>
      </section>

      <aside class="transfer-aside">
        <section class="surface-card safety-card">
          <span class="safety-card__icon"><VanIcon name="shield-o" /></span>
          <h2>安全转账提示</h2>
          <ul>
            <li>请核对收款人姓名与账户信息</li>
            <li>谨防以退款、中奖为由的转账要求</li>
            <li>数字银行不会索要您的登录密码</li>
          </ul>
        </section>
        <section class="arrival-card">
          <VanIcon name="clock-o" />
          <div><strong>到账时效</strong><span>当前渠道预计实时到账</span></div>
        </section>
      </aside>
    </div>

    <VanActionSheet
      v-model:show="showAccountSheet"
      title="选择付款账户"
      :actions="accountActions"
      cancel-text="取消"
      safe-area-inset-bottom
      @select="selectAccount"
    />
    <VanActionSheet
      v-model:show="showBeneficiarySheet"
      title="选择常用收款人"
      :actions="beneficiaryActions"
      cancel-text="取消"
      safe-area-inset-bottom
      @select="selectBeneficiary"
    />
  </div>
</template>

<style scoped>
.transfer-grid {
  align-items: start;
}

.transfer-form-card {
  padding: 22px clamp(18px, 4vw, 30px) 28px;
}

.transfer-form-card > header {
  display: flex;
  align-items: center;
  gap: 13px;
  padding-bottom: 19px;
  border-bottom: 1px solid var(--bank-line);
}

.transfer-form-card__icon {
  display: grid;
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 15px;
  color: var(--bank-blue-700);
  background: #eaf2ff;
  font-size: 22px;
}

.transfer-form-card h2 {
  margin: 0;
  font-size: 18px;
}

.transfer-form-card header p {
  margin: 5px 0 0;
  color: var(--bank-ink-500);
  font-size: 12px;
}

.transfer-form {
  margin-top: 5px;
}

.transfer-form :deep(.van-field__label) {
  width: 78px;
  color: var(--bank-ink-700);
  font-weight: 630;
}

.field-assist {
  margin: 0 0 9px 94px;
  color: var(--bank-ink-500);
  font-size: 11px;
  line-height: 1.45;
}

.amount-field {
  padding: 18px 0 14px;
  border-bottom: 1px solid var(--bank-line);
}

.amount-field label {
  color: var(--bank-ink-700);
  font-size: 13px;
  font-weight: 630;
}

.amount-field > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  margin-top: 13px;
}

.amount-field span {
  flex: 0 0 auto;
  font-size: 23px;
  font-weight: 680;
}

.amount-field input {
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  color: var(--bank-ink-900);
  background: transparent;
  font-size: clamp(30px, 8vw, 42px);
  font-weight: 760;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
}

.amount-field input::placeholder {
  color: #c9d0dc;
}

.form-error {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 13px 0 0;
  color: var(--bank-red-600);
  font-size: 13px;
}

.transfer-submit {
  margin-top: 24px;
}

.transfer-aside {
  display: grid;
  gap: 14px;
}

.safety-card {
  padding: 22px;
}

.safety-card__icon {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 14px;
  color: var(--bank-green-600);
  background: #e9f8f2;
  font-size: 21px;
}

.safety-card h2 {
  margin: 17px 0 13px;
  font-size: 17px;
}

.safety-card ul {
  display: grid;
  gap: 9px;
  margin: 0;
  padding-left: 18px;
  color: var(--bank-ink-500);
  font-size: 12px;
  line-height: 1.65;
}

.arrival-card {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 18px 20px;
  border-radius: var(--bank-radius-md);
  color: #fff;
  background: linear-gradient(135deg, #0d755f, #079f75);
  box-shadow: 0 12px 25px rgb(7 143 105 / 16%);
}

.arrival-card > :deep(.van-icon) {
  font-size: 24px;
}

.arrival-card div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.arrival-card strong {
  font-size: 14px;
}

.arrival-card span {
  color: rgb(255 255 255 / 72%);
  font-size: 11px;
}

.receipt-card {
  width: min(100%, 620px);
  margin: 16px auto 0;
  padding: clamp(26px, 6vw, 42px);
  text-align: center;
}

.receipt-card__success {
  display: grid;
  width: 66px;
  height: 66px;
  place-items: center;
  margin: 0 auto 16px;
  border-radius: 50%;
  color: #fff;
  background: linear-gradient(145deg, #11b987, #078a67);
  box-shadow: 0 13px 26px rgb(7 150 107 / 20%);
  font-size: 34px;
}

.receipt-card__eyebrow {
  color: var(--bank-green-600);
  font-size: 14px;
  font-weight: 700;
}

.receipt-card__amount {
  display: block;
  margin-top: 11px;
  font-size: clamp(34px, 9vw, 48px);
  letter-spacing: -0.04em;
}

.receipt-card > p {
  margin: 7px 0 0;
  color: var(--bank-ink-500);
  font-size: 13px;
}

.receipt-card__details {
  display: grid;
  gap: 14px;
  margin: 30px 0 0;
  padding: 22px 0;
  border-top: 1px dashed var(--bank-line);
  border-bottom: 1px dashed var(--bank-line);
}

.receipt-card__details div {
  display: flex;
  min-width: 0;
  justify-content: space-between;
  gap: 20px;
  text-align: left;
}

.receipt-card__details dt {
  flex: 0 0 auto;
  color: var(--bank-ink-500);
  font-size: 13px;
}

.receipt-card__details dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--bank-ink-900);
  font-size: 13px;
  font-weight: 650;
  text-align: right;
}

.receipt-card__actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 26px;
}

@media (max-width: 719px) {
  .transfer-aside {
    margin-top: 2px;
  }
}
</style>
