<script setup lang="ts">
import type { FeatureIcon, StepIcon } from './homeContent'

defineProps<{ name: FeatureIcon | StepIcon | 'arrow' | 'play' | 'github' | 'box' }>()
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <template v-if="name === 'layers'">
      <path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
    </template>
    <template v-else-if="name === 'shield'">
      <path d="M12 2 21 6v6c0 6-4 9-9 10-5-1-9-4-9-10V6l9-4Z"/><path d="m8.5 12 2.5 2.5 4.7-5"/>
    </template>
    <template v-else-if="name === 'hourglass'">
      <path d="M5 2h14M5 22h14M6 2v5l6 5-6 5v5M18 2v5l-6 5 6 5v5"/><path d="M9 18h6" />
    </template>
    <template v-else-if="name === 'git'">
      <circle cx="5" cy="6" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="18" r="2"/><path d="M5 8v8a2 2 0 0 0 2 2h10M7 6h8a4 4 0 0 1 4 4v6"/>
    </template>
    <template v-else-if="name === 'file'">
      <path d="M6 2h8l5 5v15H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v6h5M8 13h7M8 17h7"/>
    </template>
    <template v-else-if="name === 'key'">
      <circle cx="8" cy="15" r="4"/><path d="m11 12 9-9 2 2-2 2M17 6l2 2"/>
    </template>
    <template v-else-if="name === 'code'">
      <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>
    </template>
    <template v-else-if="name === 'check'">
      <path d="m4 12 5.5 5.5L20 6"/><circle cx="12" cy="12" r="10"/>
    </template>
    <template v-else-if="name === 'database'">
      <ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>
    </template>
    <template v-else-if="name === 'play'">
      <path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/>
    </template>
    <template v-else-if="name === 'github'">
      <path d="M9 19c-4 1-4-2-6-2m12 4v-4a4 4 0 0 0-1-3c3-.3 6-1.5 6-6a5 5 0 0 0-1.5-3.5A4.5 4.5 0 0 0 18 2s-1.3 0-4 2a14 14 0 0 0-4 0C7.3 2 6 2 6 2a4.5 4.5 0 0 0-.5 2.5A5 5 0 0 0 4 8c0 4.5 3 5.7 6 6a4 4 0 0 0-1 3v4"/>
    </template>
    <template v-else-if="name === 'box'">
      <path d="m12 2 10 5.5v9L12 22 2 16.5v-9L12 2Z"/><path d="M2 7.5 12 13l10-5.5M12 13v9"/>
    </template>
    <template v-else>
      <path d="M4 12h16m-6-6 6 6-6 6"/>
    </template>
  </svg>
</template>
