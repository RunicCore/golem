<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

type Segment = readonly [cls: string, text: string];
const LINES: readonly (readonly Segment[])[] = [
  [['k', 'export type '], ['', 'TTask = IModel<{']],
  [['', '  title: '], ['ty', 'string & MinLength<1>'], ['', ';']],
  [['', '  done: '], ['ty', 'boolean'], ['', ';']],
  [['', '  priority: '], ['ty', 'number']],
  [['ty', '    & TSerde<typeof toPriorityWord, typeof fromPriorityWord>'], ['', ';']],
  [['', '}>;']],
];
const OUTPUTS = [
  { ix: '01', name: 'Generated class', file: 'class TTaskBaseModel' },
  { ix: '02', name: 'Validation', file: 'title: MinLength<1>' },
  { ix: '03', name: 'JSON conversion', file: 'priority 2 → "normal"' },
] as const;

// Server render and reduced motion show the final state.
const typed = ref<string[][]>(LINES.map(line => line.map(([, text]) => text)));
const lit = ref<boolean[]>(OUTPUTS.map(() => true));
const typing = ref(false);
// Until hydration picks the final state or the typing run, the text stays hidden.
const booting = ref(true);
const stage = ref<HTMLElement>();
const source = ref<HTMLElement>();
const outs: HTMLElement[] = [];
const paths = ref<string[]>([]);
const pulses = ref<{ index: number; key: number }[]>([]);
const size = ref({ w: 0, h: 0 });
let observer: ResizeObserver | undefined;
let run = 0;
let pulseKey = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

function setOut(index: number, el: unknown): void {
  if (el instanceof HTMLElement) outs[index] = el;
}

function measure(): void {
  const s = stage.value?.getBoundingClientRect();
  const a = source.value?.getBoundingClientRect();
  if (!s || !a || outs.length !== OUTPUTS.length) return;
  size.value = { w: s.width, h: s.height };
  const vertical = s.width < 640;
  paths.value = outs.map(el => {
    const r = el.getBoundingClientRect();
    if (vertical) {
      const x = a.left - s.left + 18;
      return `M${x},${a.bottom - s.top} V${r.top - s.top + r.height / 2} H${r.left - s.left}`;
    }
    const x0 = a.right - s.left, y0 = a.top - s.top + a.height / 2;
    const x1 = r.left - s.left, y1 = r.top - s.top + r.height / 2;
    const xm = x0 + (x1 - x0) * 0.45, rad = Math.min(10, Math.abs(y1 - y0) / 2), dir = Math.sign(y1 - y0);
    return dir === 0 ? `M${x0},${y0} H${x1}` : `M${x0},${y0} H${xm - rad} Q${xm},${y0} ${xm},${y0 + dir * rad} V${y1 - dir * rad} Q${xm},${y1} ${xm + rad},${y1} H${x1}`;
  });
}

function later(ms: number, callback: () => void): void {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
  timers.add(timer);
}
const wait = (ms: number) => new Promise<void>(resolve => later(ms, resolve));
const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function showFinal(): void {
  run++;
  typed.value = LINES.map(line => line.map(([, text]) => text));
  lit.value = OUTPUTS.map(() => true);
  pulses.value = [];
  typing.value = false;
}

async function play(): Promise<void> {
  if (reducedMotion()) return showFinal();
  const me = ++run;
  typed.value = LINES.map(line => line.map(() => ''));
  lit.value = OUTPUTS.map(() => false);
  pulses.value = [];
  typing.value = true;
  for (const [li, line] of LINES.entries()) {
    for (const [si, [, text]] of line.entries()) {
      for (const ch of text) {
        if (me !== run) return;
        typed.value[li][si] += ch;
        await wait(14);
      }
    }
  }
  if (me !== run) return;
  typing.value = false;
  await wait(300);
  for (const index of OUTPUTS.keys()) {
    if (me !== run) return;
    const key = ++pulseKey;
    pulses.value.push({ index, key });
    later(800, () => {
      pulses.value = pulses.value.filter(p => p.key !== key);
      if (me === run) lit.value[index] = true;
    });
    await wait(160);
  }
}

onMounted(async () => {
  await nextTick();
  measure();
  if (stage.value) {
    observer = new ResizeObserver(measure);
    observer.observe(stage.value);
  }
  if (reducedMotion()) showFinal();
  else void play();
  booting.value = false;
});
onBeforeUnmount(() => {
  observer?.disconnect();
  run++;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
});
</script>

<template>
  <div ref="stage" class="home-stage" :class="{ boot: booting }">
    <svg class="traces" :viewBox="size.w ? `0 0 ${size.w} ${size.h}` : undefined" aria-hidden="true">
      <path v-for="(d, i) in paths" :key="`base-${i}`" class="base" :d="d" />
      <path v-for="p in pulses" :key="p.key" class="pulse" :d="paths[p.index]" pathLength="100" />
    </svg>
    <div ref="source" class="hud src">
      <div class="fname"><span>task.model.ts</span><span>input</span></div>
      <pre><code><span v-for="(line, li) in LINES" :key="li" class="ln"><span v-for="(segment, si) in line" :key="si" :class="segment[0]">{{ typed[li]?.[si] ?? '' }}</span><span v-if="typing && li === LINES.length - 1" class="caret" /></span></code></pre>
    </div>
    <div class="outs">
      <div v-for="(o, i) in OUTPUTS" :key="o.ix" :ref="el => setOut(i, el)" class="hud out" :class="{ on: lit[i] }">
        <span class="ix">{{ o.ix }}</span><b>{{ o.name }}</b><small>{{ o.file }}</small><span class="led" />
      </div>
    </div>
    <button class="replay" type="button" aria-label="Replay animation" @click="play"><span aria-hidden="true">↻</span> Replay</button>
  </div>
</template>

<style scoped>
.home-stage { position: relative; display: grid; grid-template-columns: 1fr 0.8fr; gap: clamp(40px, 12vw, 160px); align-items: center; box-sizing: border-box; width: min(1024px, 100% - 48px); margin: 8px auto 64px; min-height: 260px; font-family: var(--cg-font-mono); }
.traces { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.base { fill: none; stroke: var(--cg-line-2); stroke-width: 1.25; }
.pulse { fill: none; stroke: var(--vp-c-brand-1); stroke-width: 2; stroke-linecap: round; stroke-dasharray: 12 200; animation: travel .8s cubic-bezier(.4, 0, .2, 1) forwards; }
@keyframes travel { from { stroke-dashoffset: 12; } to { stroke-dashoffset: -100; } }
.hud { position: relative; background: var(--cg-panel); border: 1px solid var(--cg-line); border-radius: 4px; }
.hud::before, .hud::after { content: ''; position: absolute; width: 10px; height: 10px; border: 1.5px solid var(--vp-c-brand-1); }
.hud::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.hud::after { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
.src { padding: 12px 14px; font-size: 12.5px; line-height: 1.7; min-width: 0; }
.src pre { margin: 0; white-space: pre; overflow-x: auto; }
.fname { display: flex; justify-content: space-between; color: var(--cg-muted); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 6px; }
.ln { display: block; min-height: 1.7em; }
.k { color: var(--vp-c-brand-1); }
.ty { color: var(--cg-muted); }
.caret { display: inline-block; width: 7px; height: 14px; background: var(--vp-c-brand-1); vertical-align: -2px; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.outs { display: grid; gap: 26px; }
.out { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; padding: 10px 14px; opacity: .45; transition: opacity .4s, border-color .4s; }
.out b { font-family: var(--cg-font-display); font-size: 14px; }
.out small { grid-column: 2; color: var(--cg-muted); font-size: 11px; }
.ix { color: var(--cg-muted); font-size: 10.5px; grid-row: span 2; align-self: center; }
.led { position: absolute; right: 10px; top: -4px; width: 7px; height: 7px; border-radius: 50%; background: var(--cg-line-2); transition: background .3s, box-shadow .3s; }
.out.on { opacity: 1; border-color: var(--cg-line-2); }
.out.on .led { background: var(--vp-c-brand-1); }
:global(.dark) .out.on .led { box-shadow: 0 0 8px var(--vp-c-brand-1); }
.replay { position: absolute; right: 0; bottom: -30px; font-size: 12px; color: var(--cg-muted); }
.replay:hover { color: var(--vp-c-brand-1); }
.boot .src code, .boot .out { animation: reveal 0s 1.5s both; }
@keyframes reveal { from { visibility: hidden; } to { visibility: visible; } }
@media (min-width: 960px) { .home-stage { width: min(1024px, 100% - 128px); } }
@media (max-width: 639px) { .home-stage { grid-template-columns: 1fr; gap: 20px; } .outs { padding-left: 40px; gap: 12px; } }
@media (prefers-reduced-motion: reduce) { .caret, .pulse { animation: none; } .pulse { display: none; } .out { transition: none; } .replay { display: none; } }
</style>
