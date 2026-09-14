<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Button as VanButton,
  Icon as VanIcon,
  Skeleton as VanSkeleton,
  showConfirmDialog,
} from 'vant'

import { bankingApi } from '@/services/banking'
import { errorMessage } from '@/services/http'
import { useNotificationsStore } from '@/stores/notifications'
import { useSessionStore } from '@/stores/session'
import type { ProfileSummary } from '@/types/banking'
import { showDemoNotice } from '@/utils/feedback'

const router = useRouter()
const session = useSessionStore()
const notifications = useNotificationsStore()
const profile = ref<ProfileSummary | null>(null)
const loading = ref(true)
const loadError = ref('')

const serviceGroups = [
  [
    { icon: 'shield-o', label: '安全中心', detail: '保护等级高', tone: 'green' },
    { icon: 'setting-o', label: '登录与设备', detail: '2 台信任设备', tone: 'blue' },
    { icon: 'balance-o', label: '支付与限额', detail: '管理交易限额', tone: 'violet' },
  ],
  [
    { icon: 'description-o', label: '协议与隐私', detail: '', tone: 'blue' },
    { icon: 'service-o', label: '帮助与客服', detail: '7×24 小时', tone: 'cyan' },
    { icon: 'info-o', label: '关于数字银行', detail: '版本 1.0.0', tone: 'violet' },
  ],
]

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    profile.value = await bankingApi.getProfile()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function logout(): Promise<void> {
  try {
    await showConfirmDialog({
      title: '退出登录',
      message: '确定要退出当前演示账户吗？',
      confirmButtonText: '退出登录',
      confirmButtonColor: '#dc4a5d',
    })
  } catch {
    return
  }
  notifications.reset()
  session.logout()
  await router.replace({ name: 'login' })
}

onMounted(load)
</script>

<template>
  <div class="app-page profile-page">
    <header class="page-topbar">
      <h1>我的</h1>
      <button class="page-topbar__action" type="button" @click="showDemoNotice('个人设置')">
        <VanIcon name="setting-o" size="20" />
      </button>
    </header>

    <div v-if="loading" class="skeleton-stack">
      <VanSkeleton title avatar :row="3" />
      <VanSkeleton title :row="6" />
    </div>

    <section v-else-if="loadError" class="surface-card data-state">
      <div class="data-state__content">
        <VanIcon name="warning-o" size="38" color="#dc4a5d" />
        <h2>个人信息加载失败</h2>
        <p>{{ loadError }}</p>
        <VanButton type="primary" round @click="load">重新加载</VanButton>
      </div>
    </section>

    <template v-else-if="profile">
      <section class="profile-hero">
        <div class="profile-avatar">{{ profile.customer.avatarText }}</div>
        <div class="profile-identity">
          <div>
            <h2>{{ profile.customer.name }}</h2>
            <span>{{ profile.identityStatus }}</span>
          </div>
          <p>{{ profile.customer.maskedMobile }}</p>
          <small
            >上次登录：{{ new Date(profile.customer.lastLoginAt).toLocaleString('zh-CN') }}</small
          >
        </div>
        <VanIcon class="profile-hero__arrow" name="arrow" />
      </section>

      <section class="profile-security surface-card">
        <div>
          <span class="profile-security__icon"><VanIcon name="shield-o" /></span>
          <div>
            <strong>账户安全等级</strong>
            <p>设备、密码和交易保护均已开启</p>
          </div>
        </div>
        <span class="status-chip status-chip--green">{{ profile.securityLevel }}</span>
      </section>

      <section
        v-for="(group, groupIndex) in serviceGroups"
        :key="groupIndex"
        class="profile-group surface-card"
      >
        <button
          v-for="item in group"
          :key="item.label"
          type="button"
          @click="showDemoNotice(item.label)"
        >
          <span class="profile-group__icon" :class="`profile-group__icon--${item.tone}`">
            <VanIcon :name="item.icon" />
          </span>
          <span class="profile-group__label">{{ item.label }}</span>
          <small v-if="item.detail">{{ item.detail }}</small>
          <VanIcon name="arrow" />
        </button>
      </section>

      <VanButton class="logout-button" block round @click="logout">退出登录</VanButton>

      <p class="profile-footer">数字银行 · 演示模板<br />客服电话 {{ profile.servicePhone }}</p>
    </template>
  </div>
</template>

<style scoped>
.profile-hero {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 15px;
  padding: 23px;
  overflow: hidden;
  border-radius: var(--bank-radius-xl);
  color: #fff;
  background:
    radial-gradient(circle at 91% 0, rgb(45 143 255 / 52%), transparent 12rem),
    linear-gradient(140deg, #071a3d, #0c3d83);
  box-shadow: 0 18px 38px rgb(11 55 131 / 18%);
}

.profile-avatar {
  display: grid;
  width: 60px;
  height: 60px;
  flex: 0 0 auto;
  place-items: center;
  border: 2px solid rgb(255 255 255 / 35%);
  border-radius: 20px;
  background: rgb(255 255 255 / 14%);
  font-size: 25px;
  font-weight: 740;
}

.profile-identity {
  min-width: 0;
  flex: 1;
}

.profile-identity > div {
  display: flex;
  align-items: center;
  gap: 9px;
}

.profile-identity h2 {
  margin: 0;
  font-size: 21px;
}

.profile-identity > div span {
  padding: 3px 7px;
  border-radius: 999px;
  color: #b9f5e7;
  background: rgb(42 210 168 / 15%);
  font-size: 10px;
}

.profile-identity p {
  margin: 7px 0 0;
  color: rgb(255 255 255 / 72%);
  font-size: 13px;
}

.profile-identity small {
  display: block;
  margin-top: 5px;
  color: rgb(255 255 255 / 45%);
  font-size: 9px;
}

.profile-hero__arrow {
  flex: 0 0 auto;
  color: rgb(255 255 255 / 55%);
}

.profile-security {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  margin-top: 17px;
  padding: 17px;
}

.profile-security > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.profile-security__icon {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 14px;
  color: var(--bank-green-600);
  background: #e9f8f2;
  font-size: 20px;
}

.profile-security strong {
  font-size: 13px;
}

.profile-security p {
  margin: 4px 0 0;
  color: var(--bank-ink-500);
  font-size: 10px;
}

.profile-group {
  margin-top: 16px;
  padding: 0 17px;
}

.profile-group button {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 64px;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.profile-group button + button {
  border-top: 1px solid var(--bank-line);
}

.profile-group__icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 12px;
  font-size: 18px;
}

.profile-group__icon--green {
  color: var(--bank-green-600);
  background: #e9f8f2;
}

.profile-group__icon--blue {
  color: var(--bank-blue-700);
  background: #edf4ff;
}

.profile-group__icon--violet {
  color: #7258e8;
  background: #f1edff;
}

.profile-group__icon--cyan {
  color: #078c98;
  background: #e7f8f9;
}

.profile-group__label {
  min-width: 0;
  flex: 1;
  font-size: 14px;
  font-weight: 620;
}

.profile-group small {
  color: var(--bank-ink-500);
  font-size: 11px;
}

.profile-group button > :deep(.van-icon) {
  color: var(--bank-ink-300);
}

.logout-button {
  margin-top: 22px;
  color: var(--bank-red-600);
}

.profile-footer {
  margin: 24px 0 4px;
  color: var(--bank-ink-300);
  font-size: 10px;
  line-height: 1.7;
  text-align: center;
}

@media (min-width: 720px) {
  .profile-page {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
    gap: 0 18px;
  }

  .profile-page > .page-topbar,
  .profile-page > .profile-hero,
  .profile-page > .profile-footer,
  .profile-page > .skeleton-stack,
  .profile-page > .data-state {
    grid-column: 1 / -1;
  }

  .profile-security {
    grid-column: 1 / -1;
    margin-top: 16px;
  }

  .logout-button {
    grid-column: 1 / -1;
    width: min(100%, 420px);
    justify-self: center;
  }
}
</style>
