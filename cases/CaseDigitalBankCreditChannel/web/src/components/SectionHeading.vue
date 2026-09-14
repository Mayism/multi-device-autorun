<script setup lang="ts">
import { Icon as VanIcon } from 'vant'

defineProps<{
  title: string
  description?: string
  actionText?: string
}>()

defineEmits<{
  action: []
}>()
</script>

<template>
  <div class="section-heading">
    <div>
      <h2>{{ title }}</h2>
      <p v-if="description">{{ description }}</p>
    </div>
    <button
      v-if="actionText"
      class="section-heading__action"
      type="button"
      @click="$emit('action')"
    >
      {{ actionText }}
      <VanIcon name="arrow" />
    </button>
  </div>
</template>
