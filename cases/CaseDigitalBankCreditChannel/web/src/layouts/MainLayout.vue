<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { Tabbar as VanTabbar, TabbarItem as VanTabbarItem } from 'vant'

const route = useRoute()
const router = useRouter()

const activeTab = computed(() => route.meta.tab ?? 'home')
const hideTabbar = computed(() => Boolean(route.meta.hideTabbar))

function navigate(name: string | number): void {
  void router.push({ name: String(name) })
}
</script>

<template>
  <div class="main-layout" :class="{ 'main-layout--without-tabbar': hideTabbar }">
    <RouterView />
    <VanTabbar
      v-if="!hideTabbar"
      class="bank-tabbar"
      :model-value="activeTab"
      fixed
      safe-area-inset-bottom
      active-color="#0e6bf6"
      inactive-color="#8290a5"
      @change="navigate"
    >
      <VanTabbarItem name="home" icon="home-o">首页</VanTabbarItem>
      <VanTabbarItem name="accounts" icon="balance-list-o">账户</VanTabbarItem>
      <VanTabbarItem name="wealth" icon="chart-trending-o">财富</VanTabbarItem>
      <VanTabbarItem name="messages" icon="comment-o">消息</VanTabbarItem>
      <VanTabbarItem name="profile" icon="contact-o">我的</VanTabbarItem>
    </VanTabbar>
  </div>
</template>

<style scoped>
.main-layout {
  min-height: 100vh;
  min-height: 100dvh;
  padding-bottom: calc(var(--van-tabbar-height) + env(safe-area-inset-bottom) + 10px);
}

.main-layout--without-tabbar {
  padding-bottom: env(safe-area-inset-bottom);
}

:global(.bank-tabbar) {
  z-index: 1000;
  left: 50%;
  width: min(100%, var(--bank-content-width));
  max-width: 100%;
  padding-right: env(safe-area-inset-right);
  padding-left: env(safe-area-inset-left);
  transform: translateX(-50%);
  border-top: 1px solid rgb(226 232 241 / 88%);
  box-shadow: 0 -10px 26px rgb(22 45 84 / 7%);
}

:global(.bank-tabbar .van-tabbar-item__icon) {
  font-size: 21px;
}

:global(.bank-tabbar .van-tabbar-item__text) {
  font-size: 11px;
}
</style>
