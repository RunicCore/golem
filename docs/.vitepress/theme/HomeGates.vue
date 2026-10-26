<template>
  <figure class="home-gates">
    <div class="frame">
      <svg viewBox="0 0 1000 330" role="img" aria-label="The generated client checks the request before it sends it. On the server, parse or the NestJS model interceptor validates the body and builds the model; bad input fails with HTTP 400. The handler gets a valid model. The client checks the response when it comes back.">
        <defs>
          <marker id="gate-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="tip" d="M0,0 L10,5 L0,10 z" /></marker>
          <marker id="gate-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="tip bad" d="M0,0 L10,5 L0,10 z" /></marker>
        </defs>
        <text class="head" x="120" y="30" text-anchor="middle">WEB APP</text>
        <text class="head" x="338" y="30">NETWORK</text>
        <text class="head" x="690" y="30" text-anchor="middle">YOUR SERVER</text>
        <line class="rule" x1="330" y1="20" x2="330" y2="310" />

        <rect class="box" x="20" y="56" width="200" height="72" rx="4" />
        <text class="lbl" x="120" y="86" text-anchor="middle">Generated client</text>
        <text class="sub" x="120" y="108" text-anchor="middle">createPayment(input)</text>
        <circle class="dot" cx="20" cy="56" r="13" /><text class="dot-n" x="20" y="60" text-anchor="middle">1</text>
        <text class="edge" x="40" y="150">checks the request</text>

        <rect class="box key" x="430" y="56" width="230" height="72" rx="4" />
        <text class="lbl" x="545" y="86" text-anchor="middle">parse · interceptor</text>
        <text class="sub" x="545" y="108" text-anchor="middle">validates · builds model</text>
        <circle class="dot" cx="430" cy="56" r="13" /><text class="dot-n" x="430" y="60" text-anchor="middle">2</text>

        <rect class="box" x="760" y="56" width="220" height="72" rx="4" />
        <text class="lbl" x="870" y="86" text-anchor="middle">Your handler</text>
        <text class="sub" x="870" y="108" text-anchor="middle">gets a valid model</text>

        <line class="wire" x1="220" y1="92" x2="427" y2="92" marker-end="url(#gate-arrow)" />
        <text class="edge" x="324" y="82" text-anchor="middle">sends wire JSON</text>
        <line class="wire" x1="660" y1="92" x2="757" y2="92" marker-end="url(#gate-arrow)" />
        <text class="edge" x="708" y="82" text-anchor="middle">valid</text>

        <rect class="box bad" x="455" y="190" width="180" height="50" rx="4" />
        <text class="lbl bad" x="545" y="221" text-anchor="middle">HTTP 400</text>
        <line class="wire bad" x1="545" y1="128" x2="545" y2="187" marker-end="url(#gate-arrow-bad)" />
        <text class="edge" x="553" y="164">bad input</text>

        <polyline class="wire" points="870,128 870,290 120,290 120,131" marker-end="url(#gate-arrow)" />
        <text class="edge" x="700" y="282" text-anchor="middle">response</text>
        <circle class="dot" cx="120" cy="212" r="13" /><text class="dot-n" x="120" y="216" text-anchor="middle">3</text>
        <text class="edge" x="140" y="216">checks the response</text>
      </svg>
    </div>
    <figcaption>In the payments example, a NestJS server's controllers write <code>server/api/openapi.yaml</code>. The web app generates its client from that file, with MobX on. Amounts travel as decimal strings, so no float carries money.</figcaption>
  </figure>
</template>

<style scoped>
.home-gates { margin: 24px 0 0; }
.frame { position: relative; background: var(--cg-panel); border: 1px solid var(--cg-line); border-radius: 4px; padding: 16px; overflow-x: auto; }
.frame::before, .frame::after { content: ''; position: absolute; width: 10px; height: 10px; border: 1.5px solid var(--vp-c-brand-1); }
.frame::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.frame::after { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
svg { display: block; width: 100%; min-width: 760px; height: auto; }
figcaption { margin-top: 12px; color: var(--cg-muted); font-size: 14px; line-height: 1.6; }
.head { font-family: var(--cg-font-mono); font-size: 11px; letter-spacing: .12em; fill: var(--cg-muted); }
.lbl { font-family: var(--cg-font-display); font-size: 15px; font-weight: 600; fill: var(--vp-c-text-1); }
.lbl.bad { fill: var(--vp-c-danger-1); }
.sub { font-family: var(--cg-font-mono); font-size: 12px; fill: var(--cg-muted); }
.edge { font-size: 11.5px; font-style: italic; fill: var(--cg-muted); }
.box { fill: var(--vp-c-bg); stroke: var(--cg-line-2); stroke-width: 1.2; }
.box.key { fill: var(--vp-c-brand-soft); stroke: var(--vp-c-brand-1); stroke-width: 1.4; }
.box.bad { fill: var(--vp-c-danger-soft); stroke: var(--vp-c-danger-1); stroke-width: 1.4; }
.wire { stroke: var(--cg-line-2); stroke-width: 1.6; fill: none; }
.wire.bad { stroke: var(--vp-c-danger-1); }
.tip { fill: var(--cg-muted); }
.tip.bad { fill: var(--vp-c-danger-1); }
.rule { stroke: var(--cg-line); stroke-dasharray: 2 4; }
.dot { fill: var(--vp-c-brand-1); }
.dot-n { font-family: var(--cg-font-mono); font-size: 12px; font-weight: 700; fill: var(--vp-c-bg); }
</style>
