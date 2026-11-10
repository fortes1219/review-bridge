<script setup lang="ts">
import { computed, ref } from 'vue'

// A long schema shown as its first lines, cut with a fade, and the whole file in a native <dialog>
// (showModal: Esc closes it, focus stays inside). The text is the file itself, imported with ?raw.
type Locale = 'zh-TW' | 'en' | 'ja'

interface Props {
  source: string
  title: string
  locale?: Locale
  previewLines?: number
}

const props = withDefaults(defineProps<Props>(), { locale: 'zh-TW', previewLines: 24 })

const LABELS: Record<Locale, { open: (count: number) => string, close: string }> = {
  'zh-TW': { open: (count) => `看完整 schema（${count} 行）`, close: '關閉' },
  en: { open: (count) => `View full schema (${count} lines)`, close: 'Close' },
  ja: { open: (count) => `スキーマ全体を表示（${count} 行）`, close: '閉じる' },
}

const lines = computed(() => props.source.replace(/\n$/, '').split('\n'))
const preview = computed(() => lines.value.slice(0, props.previewLines).join('\n'))
const cut = computed(() => lines.value.length > props.previewLines)
const label = computed(() => LABELS[props.locale])
const dialog = ref<HTMLDialogElement | null>(null)

function open() {
  dialog.value?.showModal()
}

function close() {
  dialog.value?.close()
}

// A click on the backdrop lands on the <dialog> itself, not on its content.
function onDialogClick(event: MouseEvent) {
  if (event.target === dialog.value) close()
}
</script>

<template>
  <div class="schema-peek">
    <div class="schema-peek__frame" :class="{ 'schema-peek__frame--cut': cut }">
      <span class="schema-peek__name">{{ title }}</span>
      <pre class="schema-peek__code"><code>{{ preview }}</code></pre>
    </div>
    <button v-if="cut" type="button" class="schema-peek__open" @click="open">{{ label.open(lines.length) }}</button>

    <dialog ref="dialog" class="schema-peek__dialog" :aria-label="title" @click="onDialogClick">
      <div class="schema-peek__panel">
        <header class="schema-peek__head">
          <span class="schema-peek__name">{{ title }}</span>
          <button type="button" class="schema-peek__close" @click="close">{{ label.close }}</button>
        </header>
        <pre class="schema-peek__code schema-peek__code--full"><code>{{ source }}</code></pre>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.schema-peek {
  margin: 16px 0;
}

.schema-peek__frame {
  position: relative;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  overflow: hidden;
}

.schema-peek__frame--cut::after {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: 72px;
  background: linear-gradient(to bottom, transparent, var(--vp-code-block-bg));
  pointer-events: none;
}

.schema-peek__name {
  display: block;
  padding: 8px 20px 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.schema-peek__code {
  margin: 0;
  padding: 12px 20px 20px;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: var(--vp-code-font-size);
  line-height: var(--vp-code-line-height);
  color: var(--vp-code-block-color);
  background: transparent;
}

.schema-peek__open,
.schema-peek__close {
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 14px;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  cursor: pointer;
}

.schema-peek__open {
  margin-top: 8px;
}

.schema-peek__open:hover,
.schema-peek__close:hover {
  border-color: var(--vp-c-brand-1);
}

.schema-peek__dialog {
  width: min(960px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  padding: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-code-block-bg);
  color: var(--vp-c-text-1);
}

.schema-peek__dialog::backdrop {
  background: rgba(0, 0, 0, 0.5);
}

.schema-peek__panel {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 66px);
}

.schema-peek__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px 8px 0;
  border-bottom: 1px solid var(--vp-c-divider);
}

.schema-peek__head .schema-peek__name {
  padding-top: 0;
}

.schema-peek__code--full {
  flex: 1;
  overflow: auto;
}
</style>
