<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Button as VanButton, Field as VanField, Form as VanForm, Icon as VanIcon } from 'vant'

import { errorMessage } from '@/services/http'
import { useSessionStore } from '@/stores/session'
import { showDemoNotice } from '@/utils/feedback'
import { loginFormSchema } from '@/utils/validation'

const router = useRouter()
const route = useRoute()
const session = useSessionStore()

const mobile = ref('13800138000')
const password = ref('123456')
const loading = ref(false)
const formError = ref('')
const passwordVisible = ref(false)

async function submit(): Promise<void> {
  formError.value = ''
  const parsed = loginFormSchema.safeParse({ mobile: mobile.value, password: password.value })
  if (!parsed.success) {
    formError.value = parsed.error.issues[0]?.message ?? '请检查登录信息'
    return
  }

  loading.value = true
  try {
    await session.login(parsed.data)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/home'
    await router.replace(
      redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/home',
    )
  } catch (error) {
    formError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-showcase" aria-label="数字银行介绍">
      <div class="login-showcase__inner">
        <div class="brand-lockup brand-lockup--light">
          <span class="brand-mark"><span></span></span>
          <strong>数字银行</strong>
        </div>
        <div class="login-showcase__copy">
          <span class="login-showcase__eyebrow">DIGITAL BANKING</span>
          <h1>让每一笔财富<br />清晰而从容</h1>
          <p>统一管理账户、支付与财富，让日常金融服务触手可及。</p>
        </div>
        <div class="login-showcase__features">
          <span><VanIcon name="shield-o" /> 多重安全防护</span>
          <span><VanIcon name="clock-o" /> 7×24 小时服务</span>
          <span><VanIcon name="passed" /> 全程隐私保护</span>
        </div>
      </div>
    </section>

    <section class="login-panel">
      <div class="login-panel__content">
        <div class="brand-lockup brand-lockup--mobile">
          <span class="brand-mark"><span></span></span>
          <strong>数字银行</strong>
        </div>

        <header class="login-header">
          <span class="status-chip">演示环境</span>
          <h2>欢迎回来</h2>
          <p>登录后查看您的账户与财富概览</p>
        </header>

        <VanForm class="login-form" @submit="submit">
          <label class="field-label" for="mobile">手机号</label>
          <div class="field-shell">
            <VanField
              id="mobile"
              v-model="mobile"
              name="mobile"
              type="tel"
              autocomplete="username"
              maxlength="11"
              placeholder="请输入手机号"
              clearable
            >
              <template #left-icon><VanIcon name="phone-o" /></template>
            </VanField>
          </div>

          <label class="field-label" for="password">登录密码</label>
          <div class="field-shell">
            <VanField
              id="password"
              v-model="password"
              name="password"
              :type="passwordVisible ? 'text' : 'password'"
              inputmode="numeric"
              maxlength="6"
              autocomplete="current-password"
              placeholder="请输入登录密码"
            >
              <template #left-icon><VanIcon name="closed-eye" /></template>
              <template #button>
                <button
                  class="password-toggle"
                  type="button"
                  :aria-label="passwordVisible ? '隐藏密码' : '显示密码'"
                  @click="passwordVisible = !passwordVisible"
                >
                  <VanIcon :name="passwordVisible ? 'eye-o' : 'closed-eye'" />
                </button>
              </template>
            </VanField>
          </div>

          <div class="login-helper">
            <span>任意手机号，演示密码 123456</span>
            <button type="button" @click="showDemoNotice('密码找回')">忘记密码</button>
          </div>

          <p v-if="formError" class="form-error" role="alert">
            <VanIcon name="warning-o" />
            {{ formError }}
          </p>

          <VanButton
            class="login-submit"
            native-type="submit"
            type="primary"
            block
            round
            :loading="loading"
            loading-text="安全登录中"
          >
            安全登录
          </VanButton>
        </VanForm>

        <div class="demo-tip">
          <VanIcon name="info-o" />
          <span>本应用使用模拟数据，不会连接真实银行账户或处理真实资金。</span>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--bank-surface);
}

.login-showcase {
  display: none;
  position: relative;
  overflow: hidden;
  color: #fff;
  background:
    radial-gradient(circle at 82% 18%, rgb(51 159 255 / 42%), transparent 16rem),
    radial-gradient(circle at 16% 88%, rgb(25 190 193 / 27%), transparent 20rem),
    linear-gradient(145deg, #06152f 0%, #0a2c65 55%, #0958b9 100%);
}

.login-showcase::after {
  position: absolute;
  width: min(32vw, 460px);
  aspect-ratio: 1;
  right: -9vw;
  bottom: -9vw;
  border: 1px solid rgb(255 255 255 / 13%);
  border-radius: 50%;
  box-shadow:
    0 0 0 50px rgb(255 255 255 / 3%),
    0 0 0 100px rgb(255 255 255 / 2%);
  content: '';
}

.login-showcase__inner {
  position: relative;
  z-index: 1;
  display: flex;
  width: min(100%, 680px);
  min-height: 100%;
  flex-direction: column;
  margin-left: auto;
  padding: clamp(38px, 6vw, 78px);
}

.brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  font-size: 20px;
  letter-spacing: 0.04em;
}

.brand-mark {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 13px;
  background: linear-gradient(145deg, #50a5ff, #0f64f1);
  box-shadow: 0 8px 22px rgb(12 96 237 / 30%);
}

.brand-mark::before,
.brand-mark span,
.brand-mark span::after {
  display: block;
  width: 18px;
  height: 4px;
  border-radius: 999px;
  background: #fff;
  content: '';
}

.brand-mark::before {
  transform: translateY(-5px);
}

.brand-mark span::after {
  width: 12px;
  transform: translate(6px, 5px);
}

.login-showcase__copy {
  margin: auto 0;
}

.login-showcase__eyebrow {
  color: #84ccff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.22em;
}

.login-showcase__copy h1 {
  margin: 24px 0 20px;
  font-size: clamp(38px, 5vw, 64px);
  line-height: 1.15;
  letter-spacing: -0.05em;
}

.login-showcase__copy p {
  max-width: 430px;
  margin: 0;
  color: rgb(255 255 255 / 70%);
  font-size: 16px;
  line-height: 1.8;
}

.login-showcase__features {
  display: flex;
  flex-wrap: wrap;
  gap: 18px 26px;
  color: rgb(255 255 255 / 75%);
  font-size: 13px;
}

.login-showcase__features span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.login-panel {
  display: grid;
  min-width: 0;
  place-items: center;
  padding: max(26px, env(safe-area-inset-top)) clamp(20px, 6vw, 58px)
    max(26px, env(safe-area-inset-bottom));
}

.login-panel__content {
  width: min(100%, 430px);
}

.brand-lockup--mobile {
  margin-bottom: clamp(42px, 9vh, 78px);
}

.login-header h2 {
  margin: 18px 0 8px;
  font-size: clamp(30px, 8vw, 40px);
  letter-spacing: -0.05em;
}

.login-header p {
  margin: 0;
  color: var(--bank-ink-500);
  font-size: 14px;
}

.login-form {
  margin-top: 34px;
}

.field-label {
  display: block;
  margin: 19px 0 9px;
  color: var(--bank-ink-700);
  font-size: 13px;
  font-weight: 650;
}

.field-shell {
  padding: 0 16px;
  border: 1px solid var(--bank-line);
  border-radius: 15px;
  background: var(--bank-surface-soft);
  transition:
    border-color 180ms ease,
    box-shadow 180ms ease;
}

.field-shell:focus-within {
  border-color: #75a9ff;
  box-shadow: 0 0 0 4px rgb(14 107 246 / 8%);
}

.field-shell :deep(.van-field) {
  background: transparent;
}

.field-shell :deep(.van-field__left-icon) {
  margin-right: 10px;
  color: var(--bank-blue-600);
  font-size: 18px;
}

.password-toggle {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  padding: 0;
  border: 0;
  color: var(--bank-ink-500);
  background: transparent;
  cursor: pointer;
}

.login-helper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  color: var(--bank-ink-500);
  font-size: 12px;
}

.login-helper button {
  min-height: 38px;
  padding: 0;
  border: 0;
  color: var(--bank-blue-700);
  background: transparent;
}

.form-error {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 12px 0 0;
  color: var(--bank-red-600);
  font-size: 13px;
}

.login-submit {
  margin-top: 24px;
  box-shadow: 0 12px 24px rgb(14 107 246 / 22%);
}

.demo-tip {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-top: 22px;
  padding: 13px 15px;
  border-radius: 13px;
  color: var(--bank-ink-500);
  background: #f4f7fc;
  font-size: 12px;
  line-height: 1.6;
}

.demo-tip :deep(.van-icon) {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--bank-blue-600);
  font-size: 16px;
}

@media (min-width: 860px) {
  .login-page {
    grid-template-columns: minmax(420px, 1.12fr) minmax(390px, 0.88fr);
  }

  .login-showcase {
    display: block;
  }

  .brand-lockup--mobile {
    display: none;
  }
}
</style>
