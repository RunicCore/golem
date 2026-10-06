<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

// 0: declaration only · 1: JSON Schema · 2: validator · 3: call found · 4: call rewritten.
const FINAL = 4;
const STEP_MS = 1100;
// Server render and reduced motion show the final state.
const step = ref(FINAL);
const figure = ref<HTMLElement>();
let observer: IntersectionObserver | undefined;
let run = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function clearTimers(): void {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

function play(): void {
  clearTimers();
  if (reducedMotion()) {
    step.value = FINAL;
    return;
  }
  const me = ++run;
  step.value = 0;
  for (let next = 1; next <= FINAL; next++) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (me === run) step.value = next;
    }, next * STEP_MS);
    timers.add(timer);
  }
}

onMounted(() => {
  if (reducedMotion() || !figure.value) return;
  step.value = 0;
  observer = new IntersectionObserver(entries => {
    if (!entries.some(e => e.isIntersecting)) return;
    observer?.disconnect();
    play();
  }, { threshold: 0.5 });
  observer.observe(figure.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  run++;
  clearTimers();
});
</script>

<template>
  <figure ref="figure" class="how-it-works" :data-step="step">
    <div class="flow">
      <div class="hud panel decl on">
        <div class="fname">task.model.ts</div>
        <pre><code><span class="ln"><span class="k">export type </span>TTask = IModel&lt;{</span><span class="ln">  title: string &amp; <mark :class="{ on: step >= 1 }">MinLength&lt;1&gt;</mark>;</span><span class="ln">  due: <mark :class="{ on: step >= 1 }">Date</mark>;</span><span class="ln">}&gt;;</span></code></pre>
      </div>
      <span class="link across" :class="{ on: step >= 1 }" aria-hidden="true" />
      <div class="hud panel schema" :class="{ on: step >= 1 }">
        <div class="fname">JSON Schema → validator</div>
        <pre><code><span class="ln step" :class="{ on: step >= 1 }">"title": { "type": "string", <mark>"minLength": 1</mark> }</span><span class="ln step" :class="{ on: step >= 1 }">"due": { "type": "string", <mark>"format": "date-time"</mark> }</span><span class="ln step note" :class="{ on: step >= 2 }">→ compiled validator</span></code></pre>
      </div>
      <span class="link down" :class="{ on: step >= 3 }" aria-hidden="true" />
      <div class="hud panel call" :class="{ on: step >= 3 }">
        <div class="fname">Your code, compiled by golem build</div>
        <pre><code><span class="ln step" :class="{ on: step >= 3 }"><del v-if="step >= 4">parse&lt;TTask&gt;(text)</del><template v-else>parse&lt;TTask&gt;(text)</template></span><span class="ln step" :class="{ on: step >= 4 }"><ins>requireObjectCodec("TTask_…").parse(text)</ins></span></code></pre>
      </div>
    </div>
    <button class="replay" type="button" aria-label="Replay illustration" @click="play"><span aria-hidden="true">↻</span> Replay</button>
  </figure>
</template>

<style scoped>
.how-it-works { position: relative; container-type: inline-size; margin: 20px 0 44px; font-family: var(--cg-font-mono); }
.flow { display: grid; grid-template-columns: minmax(0, .8fr) 28px minmax(0, 1.2fr); grid-template-rows: auto 22px auto; grid-template-areas: "decl across schema" ". . down" "call call call"; }
.decl { grid-area: decl; } .schema { grid-area: schema; } .call { grid-area: call; }
.across { grid-area: across; } .down { grid-area: down; }
.hud { position: relative; background: var(--cg-panel); border: 1px solid var(--cg-line); border-radius: 4px; }
.hud::before, .hud::after { content: ''; position: absolute; width: 10px; height: 10px; border: 1.5px solid var(--vp-c-brand-1); opacity: 0; transition: opacity .4s; }
.hud::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.hud::after { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
.panel { padding: 10px 12px; transition: border-color .4s; }
.panel.on { border-color: var(--cg-line-2); }
.panel.on::before, .panel.on::after { opacity: 1; }
.fname { color: var(--cg-muted); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 6px; }
.panel pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11.5px; line-height: 1.7; color: var(--vp-c-text-1); }
.ln { display: block; }
.k { color: var(--vp-c-brand-1); }
.note { color: var(--cg-muted); }
.step { opacity: 0; transform: translateY(3px); transition: opacity .45s, transform .45s; }
.step.on { opacity: 1; transform: none; }
mark { background: none; color: inherit; border-radius: 2px; padding: 0 2px; white-space: nowrap; transition: background .4s; }
mark.on, .step mark { background: var(--vp-c-brand-soft); }
del { color: var(--cg-muted); }
ins { text-decoration: none; background: var(--vp-c-brand-soft); border-radius: 2px; }
.link { position: relative; overflow: hidden; background: var(--cg-line-2); }
.link::after { content: ''; position: absolute; inset: 0; background: var(--vp-c-brand-1); transition: transform .6s; }
.across { align-self: center; height: 1px; margin: 0 4px; }
.across::after { transform: scaleX(0); transform-origin: left; }
.down { justify-self: center; width: 1px; margin: 4px 0; }
.down::after { transform: scaleY(0); transform-origin: top; }
.link.on::after { transform: none; }
.replay { position: absolute; right: 0; bottom: -30px; font-size: 12px; color: var(--cg-muted); }
.replay:hover { color: var(--vp-c-brand-1); }
@container (max-width: 559px) {
  .flow { grid-template-columns: 1fr; grid-template-rows: auto 20px auto 20px auto; grid-template-areas: "decl" "across" "schema" "down" "call"; }
  .across { justify-self: center; align-self: stretch; width: 1px; height: auto; margin: 4px 0; }
  .across::after { transform: scaleY(0); transform-origin: top; }
}
@media (prefers-reduced-motion: reduce) { .step, .link::after, mark, .hud::before, .hud::after, .panel { transition: none; } .replay { display: none; } }
</style>
