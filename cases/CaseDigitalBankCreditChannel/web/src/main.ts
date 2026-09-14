import { createApp } from 'vue'
import 'vant/lib/index.css'

import App from './App.vue'
import router from './router'
import { pinia } from './stores'
import './assets/theme.css'
import './assets/base.css'

async function bootstrap(): Promise<void> {
  if ((import.meta.env.VITE_API_MODE ?? 'mock') === 'mock') {
    const { setupMockApi } = await import('./mocks')
    setupMockApi()
  }

  const app = createApp(App)
  app.use(pinia)
  app.use(router)
  await router.isReady()
  app.mount('#app')
}

void bootstrap()
