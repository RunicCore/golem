import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const docs = path.join(root, 'docs');
const dist = path.join(docs, '.vitepress/dist');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) return ['public', '.vitepress'].includes(e.name) ? [] : markdownFiles(f);
    return f.endsWith('.md') ? [f] : [];
  });
}

test('the docs site is built', () => {
  assert.ok(existsSync(path.join(dist, 'index.html')), 'run npm run docs:build first');
});

const homeHtml = path.join(dist, 'index.html');
test('the built home page server-renders the hero and the final stage state', () => {
  assert.ok(existsSync(homeHtml), 'run npm run docs:build first');
  const html = readFileSync(homeHtml, 'utf8');
  for (const text of ['Write the type once', 'Quick start', 'TTask = IModel', 'task.model.ts', 'class TaskBase', 'MinLength&lt;1&gt;', 'TSerde&lt;typeof toPriorityWord', 'priority 2 → &quot;normal&quot;']) {
    assert.ok(html.includes(text), `home HTML lacks "${text}"`);
  }
  const stage = html.slice(html.indexOf('home-stage'));
  assert.equal((stage.match(/class="[^"]*\bhud out\b[^"]*"/g) ?? []).filter(c => /\bon\b/.test(c)).length, 3, 'all three outputs must render lit before hydration');
  assert.doesNotMatch(stage, /viewBox="0 0 0 0"/, 'the trace SVG has no empty viewBox before measuring');
  assert.match(stage, /<button[^>]*class="replay"[^>]*aria-label="Replay animation"/, 'the replay button has an accessible name');
  // Hidden until hydration decides between the final state and the typing run; CSS reveals it without JavaScript.
  assert.match(stage, /^home-stage boot"/, 'the stage renders in its boot state');
});

const guideHtml = path.join(dist, 'guide/index.html');
test('the How it works illustration server-renders its final state', () => {
  assert.ok(existsSync(guideHtml), 'run npm run docs:build first');
  const html = readFileSync(guideHtml, 'utf8');
  const start = html.indexOf('<figure class="how-it-works"');
  // Scoped-style attributes are stripped so the checks read the markup.
  const figure = html.slice(start, html.indexOf('</figure>', start) + '</figure>'.length).replace(/ data-v-[0-9a-f]+/g, '');
  assert.match(figure, /data-step="4"/, 'the figure renders the last step before hydration');
  for (const text of ['task.model.ts', 'MinLength&lt;1&gt;', '&quot;minLength&quot;: 1', '&quot;format&quot;: &quot;date-time&quot;', 'compiled Ajv validator', '<del>parse&lt;TTask&gt;(text)</del>', 'requireObjectCodec(']) {
    assert.ok(figure.includes(text), `illustration lacks "${text}"`);
  }
  const steps = (figure.match(/class="[^"]*"/g) ?? []).filter(c => /\bln\b/.test(c) && /\bstep\b/.test(c));
  assert.equal(steps.length, 5);
  assert.ok(steps.every(c => /\bon\b/.test(c)), 'every revealed line renders visible before hydration');
  assert.match(figure, /<button[^>]*class="replay"[^>]*aria-label="Replay illustration"/, 'the replay button has an accessible name');
});

const benchmarksHtml = path.join(dist, 'benchmarks.html');
test('the built benchmarks page server-renders the first group table', () => {
  assert.ok(existsSync(benchmarksHtml), 'run npm run docs:build first');
  const html = readFileSync(benchmarksHtml, 'utf8');
  const table = html.slice(html.indexOf('bench-table'));
  assert.ok(html.includes('bench-table'), 'combined table rendered');
  for (const text of ['Codegen (IObject)', 'Typia', 'Zod', 'not supported', 'Parse', 'Stringify', 'Validate']) assert.ok(table.includes(text), `table lacks "${text}"`);
});

test('section links resolve to a heading id in the built site', () => {
  assert.ok(existsSync(path.join(dist, 'index.html')), 'run npm run docs:build first');
  const missing: string[] = [];
  for (const page of markdownFiles(docs)) {
    const rel = path.relative(docs, page);
    const self = `/${rel.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}`;
    for (const [, link, anchor] of readFileSync(page, 'utf8').matchAll(/\]\((\/[a-z][^)#\s]*|)#([^)\s]+)\)/g)) {
      const target = link || self;
      const html = path.join(dist, target.endsWith('/') ? `${target}index.html` : `${target}.html`);
      if (!existsSync(html) || !readFileSync(html, 'utf8').includes(`id="${anchor}"`)) missing.push(`${rel} -> ${target}#${anchor}`);
    }
  }
  assert.deepEqual(missing, []);
});
