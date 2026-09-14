import { createRouter, createWebHistory } from 'vue-router'

import MainLayout from '@/layouts/MainLayout.vue'
import { pinia } from '@/stores'
import { useSessionStore } from '@/stores/session'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { title: '安全登录', publicOnly: true },
    },
    {
      path: '/',
      component: MainLayout,
      meta: { title: '数字银行', requiresAuth: true },
      children: [
        {
          path: '',
          redirect: { name: 'home' },
        },
        {
          path: 'home',
          name: 'home',
          component: () => import('@/views/HomeView.vue'),
          meta: { title: '首页', requiresAuth: true, tab: 'home' },
        },
        {
          path: 'accounts',
          name: 'accounts',
          component: () => import('@/views/AccountsView.vue'),
          meta: { title: '我的账户', requiresAuth: true, tab: 'accounts' },
        },
        {
          path: 'accounts/:accountId',
          name: 'account-detail',
          component: () => import('@/views/AccountDetailView.vue'),
          meta: { title: '账户详情', requiresAuth: true, tab: 'accounts', hideTabbar: true },
        },
        {
          path: 'transfer',
          name: 'transfer',
          component: () => import('@/views/TransferView.vue'),
          meta: { title: '转账汇款', requiresAuth: true, hideTabbar: true },
        },
        {
          path: 'cards',
          name: 'cards',
          component: () => import('@/views/CardsView.vue'),
          meta: { title: '信用卡', requiresAuth: true, hideTabbar: true },
        },
        {
          path: 'wealth',
          name: 'wealth',
          component: () => import('@/views/WealthView.vue'),
          meta: { title: '财富', requiresAuth: true, tab: 'wealth' },
        },
        {
          path: 'messages',
          name: 'messages',
          component: () => import('@/views/MessagesView.vue'),
          meta: { title: '消息', requiresAuth: true, tab: 'messages' },
        },
        {
          path: 'profile',
          name: 'profile',
          component: () => import('@/views/ProfileView.vue'),
          meta: { title: '我的', requiresAuth: true, tab: 'profile' },
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { title: '页面不存在' },
    },
  ],
})

router.beforeEach((to) => {
  const session = useSessionStore(pinia)
  session.restore()

  if (to.meta.requiresAuth && !session.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.meta.publicOnly && session.isAuthenticated) {
    return { name: 'home' }
  }
  return true
})

router.afterEach((to) => {
  document.title = `${to.meta.title} · 数字银行`
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('.app-root')?.scrollTo({ top: 0, left: 0 })
  })
})

export default router
