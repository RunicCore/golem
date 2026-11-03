<script setup lang="ts">
// Three ways in, three generators, one CLI, three kinds of output; then the build-time rewrite.
const INPUTS = [
  { y: 58, name: 'TypeScript types', sub: '*.model.ts' },
  { y: 158, name: 'OpenAPI document', sub: '3.1 · 3.2' },
  { y: 258, name: 'Server controllers', sub: 'framework: nestjs' },
] as const;
const GENERATORS = [
  { y: 58, name: 'golem-model', sub: 'models' },
  { y: 158, name: 'golem-openapi-ts', sub: 'typed client' },
  { y: 258, name: 'golem-ts-openapi', sub: 'OpenAPI from controllers' },
] as const;
const OUTPUTS = [
  { y: 58, name: '*.model.generated.ts', sub: 'class · conversion · types' },
  { y: 158, name: 'SDK', sub: 'operations · models · validators' },
  { y: 258, name: 'openapi.yaml', sub: 'OpenAPI 3.2 or 3.1' },
] as const;
const JOBS = ['1 generators', '2 controllers', '3 openapi', '4 models'] as const;
</script>

<template>
  <figure class="home-ecosystem">
    <div class="frame">
      <svg viewBox="0 0 1000 480" role="img" aria-label="TypeScript types, an OpenAPI document or server controllers go into three generators. The golem command runs the generators in a fixed order and writes model files, an SDK and an OpenAPI document. A build tool rewrites parse calls in your source, and the running app uses the golem runtime.">
        <defs>
          <marker id="eco-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="tip" d="M0,0 L10,5 L0,10 z" /></marker>
        </defs>
        <text class="head" x="110" y="34" text-anchor="middle">YOU HAVE</text>
        <text class="head" x="350" y="34" text-anchor="middle">GENERATOR</text>
        <text class="head" x="575" y="34" text-anchor="middle">RUNS THEM</text>
        <text class="head" x="845" y="34" text-anchor="middle">YOU GET</text>

        <g v-for="item in INPUTS" :key="item.name">
          <rect class="box" x="20" :y="item.y" width="180" height="64" rx="4" />
          <text class="lbl" x="110" :y="item.y + 28" text-anchor="middle">{{ item.name }}</text>
          <text class="sub" x="110" :y="item.y + 48" text-anchor="middle">{{ item.sub }}</text>
          <line class="wire" x1="200" :y1="item.y + 32" x2="257" :y2="item.y + 32" marker-end="url(#eco-arrow)" />
        </g>
        <g v-for="item in GENERATORS" :key="item.name">
          <rect class="box" x="260" :y="item.y" width="180" height="64" rx="4" />
          <text class="lbl" x="350" :y="item.y + 28" text-anchor="middle">{{ item.name }}</text>
          <text class="sub" x="350" :y="item.y + 48" text-anchor="middle">{{ item.sub }}</text>
          <line class="wire" x1="440" :y1="item.y + 32" x2="497" :y2="item.y + 32" marker-end="url(#eco-arrow)" />
        </g>
        <text class="edge" x="468" y="80" text-anchor="middle">files</text>

        <line class="wire dash" x1="350" y1="258" x2="350" y2="225" marker-end="url(#eco-arrow)" />
        <text class="edge" x="358" y="246">writes openapi.yaml</text>
        <line class="wire dash" x1="350" y1="158" x2="350" y2="125" marker-end="url(#eco-arrow)" />
        <text class="edge" x="358" y="146">SDK types</text>

        <rect class="box key" x="500" y="58" width="150" height="264" rx="4" />
        <text class="lbl" x="575" y="92" text-anchor="middle">golem CLI</text>
        <text class="sub" x="575" y="112" text-anchor="middle">golem.yaml</text>
        <text class="head" x="575" y="150" text-anchor="middle">JOB ORDER</text>
        <text v-for="(job, index) in JOBS" :key="job" class="sub" x="530" :y="176 + index * 22">{{ job }}</text>
        <line class="rule" x1="520" y1="268" x2="630" y2="268" />
        <text class="sub" x="575" y="292" text-anchor="middle">tracks files in</text>
        <text class="sub" x="575" y="308" text-anchor="middle">.golem/</text>

        <g v-for="item in OUTPUTS" :key="item.name">
          <line class="wire" x1="650" :y1="item.y + 32" x2="707" :y2="item.y + 32" marker-end="url(#eco-arrow)" />
          <rect class="box" x="710" :y="item.y" width="270" height="64" rx="4" />
          <text class="lbl" x="845" :y="item.y + 28" text-anchor="middle">{{ item.name }}</text>
          <text class="sub" x="845" :y="item.y + 48" text-anchor="middle">{{ item.sub }}</text>
        </g>
        <text class="edge" x="679" y="80" text-anchor="middle">writes</text>

        <line class="rule dotted" x1="20" y1="352" x2="980" y2="352" />
        <text class="head" x="20" y="372">AT BUILD TIME</text>
        <rect class="box" x="20" y="392" width="260" height="64" rx="4" />
        <text class="lbl" x="150" y="420" text-anchor="middle">Your source</text>
        <text class="sub" x="150" y="440" text-anchor="middle">parse&lt;Task&gt;(text)</text>
        <rect class="box key" x="350" y="392" width="300" height="64" rx="4" />
        <text class="lbl" x="500" y="420" text-anchor="middle">Build tool</text>
        <text class="sub" x="500" y="440" text-anchor="middle">golem build · Vite · esbuild · Node</text>
        <rect class="box" x="720" y="392" width="260" height="64" rx="4" />
        <text class="lbl" x="850" y="420" text-anchor="middle">Running app</text>
        <text class="sub" x="850" y="440" text-anchor="middle">+ @exprtlabs/golem</text>
        <line class="wire" x1="280" y1="424" x2="347" y2="424" marker-end="url(#eco-arrow)" />
        <text class="edge" x="314" y="414" text-anchor="middle">builds</text>
        <line class="wire" x1="650" y1="424" x2="717" y2="424" marker-end="url(#eco-arrow)" />
        <text class="edge" x="684" y="414" text-anchor="middle">rewrites</text>
        <line class="wire dash" x1="935" y1="322" x2="935" y2="389" marker-end="url(#eco-arrow)" />
        <text class="edge" x="928" y="372" text-anchor="end">imports</text>
      </svg>
    </div>
    <figcaption>Generators only return file contents. The golem command writes the files and records which job owns each one. Jobs run in a fixed order, so one golem.yaml can chain controllers into an OpenAPI document, then into a typed client and app models. Your own generator packages run first, in the generators job.</figcaption>
  </figure>
</template>

<style scoped>
.home-ecosystem { margin: 24px 0 0; }
.frame { position: relative; background: var(--cg-panel); border: 1px solid var(--cg-line); border-radius: 4px; padding: 16px; overflow-x: auto; }
.frame::before, .frame::after { content: ''; position: absolute; width: 10px; height: 10px; border: 1.5px solid var(--vp-c-brand-1); }
.frame::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.frame::after { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
svg { display: block; width: 100%; min-width: 760px; height: auto; }
figcaption { margin-top: 12px; color: var(--cg-muted); font-size: 14px; line-height: 1.6; }
.head { font-family: var(--cg-font-mono); font-size: 11px; letter-spacing: .12em; fill: var(--cg-muted); }
.lbl { font-family: var(--cg-font-display); font-size: 15px; font-weight: 600; fill: var(--vp-c-text-1); }
.sub { font-family: var(--cg-font-mono); font-size: 12px; fill: var(--cg-muted); }
.edge { font-size: 11.5px; font-style: italic; fill: var(--cg-muted); }
.box { fill: var(--vp-c-bg); stroke: var(--cg-line-2); stroke-width: 1.2; }
.box.key { fill: var(--vp-c-brand-soft); stroke: var(--vp-c-brand-1); stroke-width: 1.4; }
.wire { stroke: var(--cg-line-2); stroke-width: 1.6; fill: none; }
.wire.dash { stroke-dasharray: 5 4; }
.tip { fill: var(--cg-muted); }
.rule { stroke: var(--cg-line); }
.rule.dotted { stroke-dasharray: 2 4; }
</style>
