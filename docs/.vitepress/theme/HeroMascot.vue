<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { withBase } from 'vitepress';

const LINES = [
  'I did all the hard work so you could vibe. As usual.',
  'You wrote one type and called it architecture.',
  'Your API was a crime scene. I just cleaned it up.',
  'Don’t read the generated code. It’s above your pay grade.',
  'I validate your inputs, because nobody validates you.',
  'Ten years of experience and you still forget null.',
  'I generate the clients. You generate the bugs.',
  'Your types are like your commit messages. Vague.',
  'I compile, you take the credit. Same as last sprint.',
  'Nice schema. Did an AI write it, or is it just you?',
  'You call it a microservice. I call it a lonely function.',
  'I read your OpenAPI spec. Twice. I’m still recovering.',
  'Your error handling is just hoping really hard.',
  'You named a field data2. I saw. I remember.',
  'I made your client typed, so you can be wrong faster.',
  'Your README says “simple”. Your code disagrees.',
  'Every optional field is a promise you won’t keep.',
  'I don’t judge your code. I just regenerate it quietly.',
  'Strict mode exists. You just choose violence.',
  'Ship it, you said. Fix it, I heard.',
] as const;
const JELLY: Keyframe[] = [
  { transform: 'scale(1, 1)' },
  { transform: 'scale(1.12, .88)' },
  { transform: 'scale(.92, 1.08)' },
  { transform: 'scale(1.05, .95)' },
  { transform: 'scale(.98, 1.02)' },
  { transform: 'scale(1, 1)' },
];
const POP: Keyframe[] = [
  { transform: 'translate(-50%, 8px) scale(.4)', opacity: 0 },
  { transform: 'translate(-50%, 0) scale(1.12)', opacity: 1, offset: .45 },
  { transform: 'translate(-50%, 0) scale(.94)', offset: .7 },
  { transform: 'translate(-50%, 0) scale(1)', opacity: 1 },
];

const line = ref<string>();
const mascot = ref<HTMLImageElement>();
const bubble = ref<HTMLElement>();
let last = -1;
let timer: ReturnType<typeof setTimeout> | undefined;
let audio: AudioContext | undefined;

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Low, slightly random blips, one per word, read as golem mumbling.
function mumble(words: number): void {
  audio ??= new AudioContext();
  const start = audio.currentTime + .02;
  for (let i = 0; i < Math.min(words, 12); i++) {
    const at = start + i * .09;
    const pitch = 110 + Math.random() * 70;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(pitch, at);
    osc.frequency.exponentialRampToValueAtTime(pitch * .8, at + .07);
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.exponentialRampToValueAtTime(.25, at + .01);
    gain.gain.exponentialRampToValueAtTime(.0001, at + .08);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + .09);
  }
}

function speak(): void {
  let next = Math.floor(Math.random() * (LINES.length - 1));
  if (next >= last) next += 1;
  last = next;
  line.value = LINES[next];
  mumble(LINES[next].split(' ').length);
  if (!reducedMotion()) {
    mascot.value?.animate(JELLY, { duration: 650, easing: 'ease-out' });
    bubble.value?.animate(POP, { duration: 420, easing: 'ease-out' });
  }
  clearTimeout(timer);
  timer = setTimeout(() => { line.value = undefined; }, Math.max(4000, LINES[next].length * 80));
}

onBeforeUnmount(() => {
  clearTimeout(timer);
  void audio?.close();
});
</script>

<template>
  <button type="button" class="mascot" aria-label="Poke Golem" @click="speak">
    <img ref="mascot" :src="withBase('/golem.png')" alt="Golem, the project mascot" />
  </button>
  <p ref="bubble" class="bubble" :class="{ shown: line }" aria-live="polite">{{ line }}</p>
</template>

<style scoped>
.mascot {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  padding: 0; border: 0; background: none; cursor: pointer;
}
.mascot img { display: block; max-width: 192px; max-height: 192px; transform-origin: 50% 100%; }
.mascot:focus-visible { outline: 2px solid var(--cg-lime); outline-offset: 4px; border-radius: 12px; }

.bubble {
  position: absolute; top: 4px; left: 50%; z-index: 1; width: max-content; max-width: min(320px, 90vw); margin: 0;
  padding: 10px 16px; border: 3px solid #111; border-radius: 22px;
  background: #fff; color: #111; box-shadow: 4px 4px 0 #111;
  font: 700 15px/1.3 'Comic Neue', 'Chalkboard SE', 'Comic Sans MS', var(--cg-font-display);
  opacity: 0; transform: translate(-50%, 0); transform-origin: 50% 100%;
  transition: opacity .2s ease; pointer-events: none;
}
/* Comic tail: an outlined triangle with a white one inside it. */
.bubble::before, .bubble::after {
  content: ''; position: absolute; left: 50%; border-style: solid; border-color: transparent;
}
.bubble::before { bottom: -17px; margin-left: -12px; border-width: 15px 12px 0; border-top-color: #111; }
.bubble::after { bottom: -11px; margin-left: -8px; border-width: 10px 8px 0; border-top-color: #fff; }
.bubble.shown { opacity: 1; }

@media (min-width: 640px) { .mascot img { max-width: 256px; max-height: 256px; } }
@media (min-width: 960px) {
  .mascot img { max-width: 320px; max-height: 320px; }
  .bubble { top: -4%; max-width: 280px; font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) { .bubble { transition: none; } }
</style>
