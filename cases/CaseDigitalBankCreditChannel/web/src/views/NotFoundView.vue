<script setup lang="ts">
import { useRouter } from 'vue-router'
import { Button as VanButton, Icon as VanIcon } from 'vant'

const router = useRouter()
</script>

<template>
  <main class="not-found-page">
    <section class="surface-card">
      <span><VanIcon name="underway-o" /></span>
      <h1>页面走丢了</h1>
      <p>您访问的页面不存在或已经调整。</p>
      <VanButton type="primary" round @click="router.replace({ name: 'home' })">返回首页</VanButton>
    </section>
  </main>
</template>

<style scoped>
.not-found-page {
  display: grid;
  min-height: 100vh;
  min-height: 100dvh;
  place-items: center;
  padding: 24px;
}

.not-found-page section {
  width: min(100%, 440px);
  padding: 40px 28px;
  text-align: center;
}

.not-found-page section > span {
  display: grid;
  width: 68px;
  height: 68px;
  place-items: center;
  margin: 0 auto;
  border-radius: 22px;
  color: var(--bank-blue-700);
  background: #edf4ff;
  font-size: 34px;
}

.not-found-page h1 {
  margin: 20px 0 8px;
  font-size: 24px;
}

.not-found-page p {
  margin: 0 0 22px;
  color: var(--bank-ink-500);
  font-size: 13px;
}
</style>
