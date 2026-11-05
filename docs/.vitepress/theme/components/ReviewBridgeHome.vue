<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import BridgeIcon from './BridgeIcon.vue'
import { HOME_CONTENT, type HomeLocale } from './homeContent'
import bridgeImage from '../assets/bridge-command-deck.webp'

interface Props {
  locale?: HomeLocale
  guideHref?: string
  githubHref?: string
  npmHref?: string
}

const props = withDefaults(defineProps<Props>(), {
  locale: 'zh-TW',
  guideHref: '/guide/',
})
const copy = computed(() => HOME_CONTENT[props.locale])
const guideLink = computed(() => props.guideHref.startsWith('/') ? withBase(props.guideHref) : props.guideHref)
const stage = ref<HTMLElement | null>(null)

let allowMotion = false
let frame = 0
let x = 0
let y = 0

function onStagePointerMove(event: PointerEvent) {
  if (!allowMotion || !stage.value) return
  const bounds = stage.value.getBoundingClientRect()
  x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 15
  y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 9
  if (frame) return
  frame = window.requestAnimationFrame(() => {
    stage.value?.style.setProperty('--rb-parallax-x', `${x.toFixed(2)}px`)
    stage.value?.style.setProperty('--rb-parallax-y', `${y.toFixed(2)}px`)
    frame = 0
  })
}

function resetStage() {
  if (!stage.value) return
  if (frame) window.cancelAnimationFrame(frame)
  frame = 0
  stage.value.style.setProperty('--rb-parallax-x', '0px')
  stage.value.style.setProperty('--rb-parallax-y', '0px')
}

function onCardPointerMove(event: PointerEvent) {
  if (!allowMotion) return
  const el = event.currentTarget
  if (!(el instanceof HTMLElement)) return
  const bounds = el.getBoundingClientRect()
  const px = (event.clientX - bounds.left) / bounds.width
  const py = (event.clientY - bounds.top) / bounds.height
  el.style.setProperty('--rb-pointer-x', `${(px * 100).toFixed(1)}%`)
  el.style.setProperty('--rb-pointer-y', `${(py * 100).toFixed(1)}%`)
  el.style.setProperty('--rb-tilt-x', `${((0.5 - py) * 2.4).toFixed(2)}deg`)
  el.style.setProperty('--rb-tilt-y', `${((px - 0.5) * 2.4).toFixed(2)}deg`)
}

function onCardPointerLeave(event: PointerEvent) {
  const el = event.currentTarget
  if (!(el instanceof HTMLElement)) return
  el.style.setProperty('--rb-tilt-x', '0deg')
  el.style.setProperty('--rb-tilt-y', '0deg')
}

onMounted(() => {
  allowMotion = window.matchMedia('(pointer: fine) and (hover: hover)').matches
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
})

onBeforeUnmount(() => {
  if (frame) window.cancelAnimationFrame(frame)
})
</script>

<template>
  <main class="rb-command-home">
    <div
      ref="stage"
      class="rb-stage"
      :style="{ '--rb-bridge-image': `url('${bridgeImage}')` }"
      @pointermove="onStagePointerMove"
      @pointerleave="resetStage"
    >
      <div class="rb-artwork" aria-hidden="true" />
      <div class="rb-stage-vignette" aria-hidden="true" />

      <section class="rb-hero" aria-labelledby="rb-home-title">
        <div class="rb-hero-copy">
          <p class="rb-eyebrow"><span class="rb-eyebrow-dash" />{{ copy.eyebrow }}</p>
          <p class="rb-product-label">{{ copy.productName }}</p>
          <h1 id="rb-home-title" class="rb-title">
            <span>{{ copy.titleFirst }}</span><span class="rb-accent-text">{{ copy.titleAccent }}</span>
          </h1>
          <span class="rb-short-rule" aria-hidden="true" />
          <p class="rb-lead">{{ copy.lead }}</p>
          <div class="rb-actions">
            <a class="rb-action rb-action-primary" :href="guideLink">
              <BridgeIcon name="play" />{{ copy.primaryAction }}
            </a>
            <a v-if="props.githubHref" class="rb-action rb-action-secondary" :href="props.githubHref" target="_blank" rel="noopener noreferrer"><BridgeIcon name="github" />GitHub</a>
            <span v-else class="rb-action rb-action-secondary rb-action-placeholder" aria-disabled="true" title="TEMP: Connect your actual GitHub URL"><BridgeIcon name="github" />GitHub</span>
            <a v-if="props.npmHref" class="rb-action rb-action-secondary" :href="props.npmHref" target="_blank" rel="noopener noreferrer"><BridgeIcon name="box" />npm</a>
            <span v-else class="rb-action rb-action-secondary rb-action-placeholder" aria-disabled="true" title="TEMP: Connect your actual npm URL"><BridgeIcon name="box" />npm</span>
          </div>
        </div>
        <div class="rb-hero-hud" aria-hidden="true">
          <span class="rb-hud-heading">COMMAND / TEMP</span>
          <span class="rb-hud-line"><i /> <b>00 — 00</b></span>
          <span class="rb-hud-line"><i /> <b>···</b></span>
          <span class="rb-hud-line"><i /> <b>—</b></span>
        </div>
      </section>

      <section class="rb-features" aria-label="Feature placeholders">
        <div
          v-for="(feature, i) in copy.features"
          :key="feature.id"
          class="rb-feature-card"
          @pointermove="onCardPointerMove"
          @pointerleave="onCardPointerLeave"
        >
          <div class="rb-card-sweep" aria-hidden="true" />
          <div class="rb-card-top">
            <BridgeIcon :name="feature.icon" class="rb-card-icon" />
            <span class="rb-card-num">0{{ i + 1 }} / 04</span>
          </div>
          <div class="rb-card-copy">
            <p class="rb-card-kicker">{{ feature.kicker }}</p>
            <h2>{{ feature.title }}</h2>
            <p>{{ feature.description }}</p>
          </div>
          <span class="rb-card-edge" aria-hidden="true" />
        </div>
      </section>

      <section class="rb-workflow" :aria-label="copy.workflowLabel">
        <div class="rb-workflow-name">
          <span>{{ copy.workflowLabel }}</span><span class="rb-slashes" aria-hidden="true">//</span>
        </div>
        <ol class="rb-steps">
          <li v-for="step in copy.steps" :key="step.id" class="rb-step">
            <span class="rb-step-unit"><BridgeIcon :name="step.icon" />{{ step.label }}</span>
            <BridgeIcon v-if="step.id !== 'step-5'" class="rb-step-arrow" name="arrow" />
          </li>
        </ol>
      </section>
    </div>
  </main>
</template>

<style scoped>
.rb-command-home {
  --rb-deep: #06101c;
  --rb-surface: #0b1a2b;
  --rb-white: #f6f9ff;
  --rb-muted: #a9b8cb;
  --rb-cyan: #67bdfd;
  --rb-violet: #a69eff;
  isolation: isolate;
  position: relative;
  width: 100vw;
  margin-inline-start: calc(50% - 50vw);
  min-height: calc(100vh - 64px);
  overflow: clip;
  color: var(--rb-white);
  background: #06101c;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, 'Noto Sans TC', sans-serif;
}
.rb-command-home *, .rb-command-home *::before, .rb-command-home *::after { box-sizing: border-box; }
.rb-stage {
  --rb-parallax-x: 0px;
  --rb-parallax-y: 0px;
  position: relative;
  padding: clamp(66px, 7.2vw, 112px) 32px 80px;
  overflow: hidden;
  background: radial-gradient(ellipse 60% 35% at 66% 83%, rgba(33, 72, 125, .17), transparent 90%), #06101c;
}
.rb-artwork {
  position: absolute;
  z-index: 0;
  pointer-events: none;
  top: -12px;
  left: -14px;
  width: calc(100% + 28px);
  height: clamp(500px, 45vw, 690px);
  background-image: var(--rb-bridge-image);
  background-position: center top;
  background-repeat: no-repeat;
  background-size: 100% 100%;
  transform: translate3d(var(--rb-parallax-x), var(--rb-parallax-y), 0) scale(1.012);
  transition: transform 420ms cubic-bezier(.18, .7, .2, 1);
  will-change: transform;
}
.rb-stage-vignette {
  position: absolute;
  z-index: 0;
  pointer-events: none;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(5,12,22,.04) 0%, rgba(5,12,22,0) 33%, rgba(5,12,22,.25) 55%, #06101c 80%),
    linear-gradient(90deg, rgba(5,13,25,.45), transparent 34%);
}
.rb-hero, .rb-features, .rb-workflow { position: relative; z-index: 1; max-width: 1360px; margin-inline: auto; }
.rb-hero { min-height: clamp(420px, 30vw, 520px); display: flex; justify-content: space-between; align-items: flex-start; }
.rb-hero-copy { position: relative; z-index: 2; width: min(51%, 620px); }
.rb-eyebrow {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 0 25px;
  color: #a5d2ff;
  font-size: 12px;
  font-weight: 650;
  line-height: 1.4;
  letter-spacing: .34em;
}
.rb-eyebrow-dash { width: 22px; height: 2px; background: #74bfff; box-shadow: 0 0 9px rgba(85,172,255,.3); }
.rb-product-label { margin: 0 0 10px; color: #ecf4ff; font-size: clamp(18px, 2vw, 26px); font-weight: 650; letter-spacing: -.025em; }
.rb-title {
  margin: 0;
  color: #f9fbff;
  font-size: clamp(43px, 4.5vw, 69px);
  font-weight: 780;
  line-height: 1.19;
  letter-spacing: -.055em;
  text-wrap: balance;
}
.rb-title span { display: inline; }
.rb-accent-text { color: #84b9ff; text-shadow: 0 0 24px rgba(104,141,229,.13); }
.rb-short-rule { display: block; width: 52px; height: 3px; margin: 26px 0 19px; background: #438be4; }
.rb-lead { max-width: 510px; margin: 0; color: #c3d0e0; font-size: clamp(16px, 1.32vw, 18px); line-height: 1.85; text-wrap: pretty; }
.rb-actions { display: flex; flex-wrap: wrap; gap: 11px; margin-top: 30px; }
.rb-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 43px;
  padding: 0 23px;
  border: 1px solid rgba(179,205,237,.44);
  border-radius: 999px;
  color: #f5f8ff;
  background: rgba(9,19,32,.65);
  text-decoration: none;
  font-size: 14px;
  font-weight: 630;
  line-height: 1.4;
  transition: border-color 180ms ease, transform 180ms ease, background 180ms ease, box-shadow 180ms ease;
}
.rb-action svg { width: 16px; height: 16px; }
.rb-action-primary { border-color: #799cfa; background: linear-gradient(115deg,#426bd1,#274780); box-shadow: inset 0 1px rgba(255,255,255,.17), 0 7px 24px rgba(42,84,181,.18); }
.rb-action-placeholder { opacity: .73; cursor: not-allowed; }
.rb-action:not(.rb-action-placeholder):is(:hover,:focus-visible) { transform: translateY(-2px); border-color: #91c4ff; background-color: #24466f; box-shadow: 0 7px 20px rgba(73,124,211,.18); }
.rb-action:focus-visible { outline: 2px solid #a4d7ff; outline-offset: 4px; }
.rb-hero-hud { position: absolute; z-index: 1; top: 35%; right: 13%; width: 160px; height: 92px; display: grid; align-content: space-evenly; padding: 10px 15px; color: rgba(188,220,255,.7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; letter-spacing: .09em; pointer-events: none; }
.rb-hud-heading { font-size: 9px; color: #94bce9; letter-spacing: .12em; }
.rb-hud-line { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(118,171,216,.13); }
.rb-hud-line i { display: block; width: 22px; height: 2px; background: rgba(98,159,224,.5); }
.rb-hud-line b { font-weight: 400; color: #9ddcf0; }
.rb-features { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 18px; margin-block: 48px 16px; }
.rb-feature-card {
  --rb-pointer-x: 50%; --rb-pointer-y: 50%; --rb-tilt-x: 0deg; --rb-tilt-y: 0deg;
  position: relative; min-height: 228px; padding: 26px 27px 25px; overflow: hidden; isolation: isolate;
  border: 1px solid rgba(121,160,202,.46); border-radius: 17px;
  background: linear-gradient(152deg,rgba(23,42,65,.94),rgba(10,25,44,.95) 64%,rgba(12,28,49,.97));
  box-shadow: inset 0 1px 0 rgba(204,233,255,.11), 0 15px 36px rgba(0,5,14,.24);
  transform: perspective(850px) rotateX(var(--rb-tilt-x)) rotateY(var(--rb-tilt-y));
  transition: transform 240ms ease, border-color 230ms ease, box-shadow 230ms ease;
  outline: none;
}
.rb-feature-card::before {
  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: radial-gradient(280px circle at var(--rb-pointer-x) var(--rb-pointer-y),rgba(93,158,255,.16),transparent 69%);
  opacity: 0; transition: opacity 260ms ease;
}
.rb-feature-card::after {
  content: ''; position: absolute; inset: -60% auto -60% -120%; z-index: 2; width: 38%; pointer-events:none;
  transform: skewX(-29deg) translateX(0); opacity: 0;
  background: linear-gradient(90deg,transparent,rgba(169,208,255,.02) 22%,rgba(170,207,255,.24) 51%,rgba(182,141,255,.06) 76%,transparent);
}
.rb-feature-card:hover {
  border-color: rgba(127,173,255,.84);
  box-shadow: inset 0 1px rgba(231,245,255,.17), 0 10px 33px rgba(26,68,138,.22), 0 0 0 1px rgba(112,130,229,.16);
}
.rb-feature-card:hover::before { opacity: 1; }
.rb-feature-card:hover::after { animation: rb-card-sweep 850ms cubic-bezier(.16,.55,.4,1) both; }
@keyframes rb-card-sweep { from { transform: skewX(-29deg) translateX(0); opacity: 0; } 14% { opacity: 1; } 80% { opacity: .85; } to { transform: skewX(-29deg) translateX(1250%); opacity: 0; } }
.rb-card-top { display: flex; align-items: flex-start; justify-content: space-between; color: #8bc2ff; }
.rb-card-top svg { width: 45px; height: 45px; filter: drop-shadow(0 0 8px rgba(84,149,240,.17)); }
.rb-feature-card:nth-child(2) .rb-card-top, .rb-feature-card:nth-child(4) .rb-card-top { color: #afa0ff; }
.rb-card-num { color: #6e8aa7; font-size: 10px; font-weight: 700; letter-spacing: .14em; }
.rb-card-copy { margin-top: 24px; }
.rb-card-kicker { margin: 0 0 7px; color: #7396b7; font-size: 10px; font-weight: 700; letter-spacing: .18em; }
.rb-card-copy h2 { margin: 0 0 11px; color: #f2f7ff; font-size: clamp(17px,1.45vw,21px); line-height: 1.45; font-weight: 700; letter-spacing: -.02em; }
.rb-card-copy > p:last-child { margin:0; color: #a9bed4; font-size: 14px; line-height: 1.75; }
.rb-card-edge { position: absolute; height: 1px; bottom: 0; left: 17px; right: 17px; background: linear-gradient(90deg,transparent,rgba(86,160,241,.25),transparent); }
.rb-workflow {
  display: flex; gap: 30px; align-items: center; min-height: 84px; margin-top: 38px;
  border-block: 1px solid rgba(111,148,182,.26); padding: 17px 8px;
}
.rb-workflow-name { display: flex; white-space: nowrap; align-items: center; gap: 13px; font-size: 16px; font-weight: 700; color: #e9f2ff; }
.rb-slashes { color: #6591fa; font-size: 19px; font-weight: 800; letter-spacing: .12em; }
.rb-steps { display: flex; flex: 1; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 0; margin:0; list-style: none; }
.rb-step { min-width: 0; display: flex; gap: clamp(4px,1.2vw,24px); align-items: center; }
.rb-step-unit { display: flex; min-width: 0; align-items: center; gap: 10px; padding: 5px 13px 5px 7px; border: 1px solid rgba(96,130,170,.25); border-radius: 10px; background: rgba(18,37,60,.72); color: #b9cbe0; font-size: 12px; white-space: nowrap; }
.rb-step-unit svg { width: 30px; height: 30px; padding: 6px; flex-shrink: 0; color: #96baff; border: 1px solid rgba(102,158,222,.3); border-radius: 7px; background: rgba(27,57,92,.45); }
.rb-step-arrow { width: 16px; height:16px; flex-shrink:0; color: #829ab7; }
/* Scope VitePress page-layout overrides to this opt-in homepage class only. */
:global(html:has(.rb-command-home)) {
  overflow-x: clip;
  --vp-c-bg: #06101c;
  --vp-c-bg-soft: #0b1a2b;
  --vp-nav-bg-color: rgba(7, 17, 31, .98);
  --vp-c-text-1: #f0f5ff;
  --vp-c-text-2: #bdc9da;
}
:global(html:has(.rb-command-home) .VPNavBar) {
  background: rgba(7, 17, 31, .98);
  color: #ebf2fc;
  border-bottom: 1px solid rgba(117, 148, 186, .12);
  backdrop-filter: blur(18px);
}
:global(html:has(.rb-command-home) .VPNavBar .divider-line) {
  background-color: rgba(115, 149, 189, .13);
}
:global(.VPPage:has(.rb-command-home) > .container) { max-width: none !important; margin: 0 !important; padding: 0 !important; }
:global(.rb-command-page .VPPage) { padding-bottom: 0 !important; }
:global(.rb-command-page .VPPage > .container) { max-width: none !important; padding: 0 !important; margin: 0 !important; }
:global(.rb-command-page .VPPage .content) { max-width: none !important; padding: 0 !important; }
:global(.rb-command-page .VPPage .content-container) { max-width: none !important; padding: 0 !important; }
:global(.rb-command-page .VPPage .main) { max-width: none !important; padding: 0 !important; }
:global(.rb-command-page .VPNavBar) { backdrop-filter: blur(18px); }
@media (min-width: 1440px) {
  .rb-artwork { background-size: cover; background-position: center 0; }
}
@media (max-width: 1150px) {
  .rb-hero { min-height: 420px; }
  .rb-features { gap: 12px; }
  .rb-feature-card { padding: 20px; }
  .rb-step-unit { gap: 6px; padding-right: 6px; font-size: 11px; }
  .rb-step-unit svg { width: 27px; height: 27px; }
  .rb-workflow { gap: 18px; }
}
@media (max-width: 900px) {
  .rb-stage { padding: 78px 24px 65px; }
  .rb-artwork { height: 540px; background-size: auto 100%; background-position: 66% top; opacity: .72; }
  .rb-stage-vignette { background: linear-gradient(90deg, #06101c 0%, rgba(6,16,28,.88) 35%,rgba(6,16,28,.48) 77%,rgba(6,16,28,.25)),linear-gradient(180deg,transparent 10%,#06101c 69%); }
  .rb-hero { min-height: 420px; }
  .rb-hero-copy { width: 68%; }
  .rb-hero-hud { display: none; }
  .rb-features { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .rb-feature-card { min-height: 215px; }
  .rb-workflow { flex-direction: column; align-items:flex-start; }
  .rb-steps { width: 100%; }
}
@media (max-width: 640px) {
  .rb-command-home { min-height: calc(100vh - 64px); }
  .rb-stage { padding: 51px 18px 52px; }
  .rb-artwork { height: 465px; background-size: auto 100%; background-position: 65% top; opacity: .55; }
  .rb-stage-vignette { background: linear-gradient(90deg,rgba(6,16,28,.96),rgba(6,16,28,.67) 80%),linear-gradient(180deg,rgba(6,16,28,.06),#06101c 67%); }
  .rb-hero { min-height: 440px; }
  .rb-hero-copy { width: 100%; }
  .rb-eyebrow { font-size: 9px; gap: 8px; letter-spacing: .19em; margin-bottom: 23px; }
  .rb-product-label { font-size: 19px; }
  .rb-title { font-size: clamp(36px,9.5vw,52px); line-height: 1.22; }
  .rb-short-rule { margin: 21px 0 14px; }
  .rb-lead { font-size: 15px; line-height: 1.8; max-width: 33ch; }
  .rb-actions { gap: 8px; margin-top: 26px; }
  .rb-action { padding-inline: 15px; font-size: 13px; min-height:40px; }
  .rb-features { grid-template-columns: 1fr; gap: 12px; }
  .rb-feature-card { min-height: 190px; padding: 19px 20px; }
  .rb-card-top svg { width: 35px; height: 35px; }
  .rb-card-copy { margin-top: 16px; }
  .rb-workflow { margin-top: 28px; padding-top: 20px; }
  .rb-steps { display: grid; grid-template-columns: 1fr; gap: 9px; }
  .rb-step { width: 100%; }
  .rb-step-unit { width: 100%; font-size: 12px; gap: 10px; }
  .rb-step-arrow { display:none; }
}
@media (prefers-reduced-motion: reduce) {
  .rb-artwork, .rb-feature-card, .rb-feature-card::before, .rb-action { animation:none !important; transform:none !important; transition:none !important; }
  .rb-feature-card::after { display:none; }
}
</style>
