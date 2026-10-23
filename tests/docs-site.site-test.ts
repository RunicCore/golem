import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildBenchmarkSiteProjection } from '../scripts/benchmark/site-projection.js';

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

const homeHtml = path.join(dist, 'index.html');
test('the built home page server-renders the hero and the final stage state', () => {
  assert.ok(existsSync(homeHtml), 'run npm run docs:build first');
  const html = readFileSync(homeHtml, 'utf8');
  for (const text of ['Write the type once', 'Quick start', 'TTask = IModel', 'task.model.ts', 'class TTaskBaseModel', 'MinLength&lt;1&gt;', 'TSerde&lt;typeof toPriorityWord', 'priority 2 → &quot;normal&quot;']) {
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
  for (const text of ['task.model.ts', 'MinLength&lt;1&gt;', '&quot;minLength&quot;: 1', '&quot;format&quot;: &quot;date-time&quot;', 'compiled validator', '<del>parse&lt;TTask&gt;(text)</del>', 'requireObjectCodec(']) {
    assert.ok(figure.includes(text), `illustration lacks "${text}"`);
  }
  const steps = (figure.match(/class="[^"]*"/g) ?? []).filter(c => /\bln\b/.test(c) && /\bstep\b/.test(c));
  assert.equal(steps.length, 5);
  assert.ok(steps.every(c => /\bon\b/.test(c)), 'every revealed line renders visible before hydration');
  assert.match(figure, /<button[^>]*class="replay"[^>]*aria-label="Replay illustration"/, 'the replay button has an accessible name');
});

const benchmarksHtml = path.join(dist, 'benchmarks.html');
const projection = buildBenchmarkSiteProjection(root);
// protects: R-30 the built page renders the speed table of the golem setups; R-24 it says benchmarks are for reference only
test('the built benchmarks page server-renders the disclaimer and the speed table of the golem setups', () => {
  assert.ok(existsSync(benchmarksHtml), 'run npm run docs:build first');
  const html = readFileSync(benchmarksHtml, 'utf8');
  const table = html.slice(html.indexOf('bench-table'));
  assert.ok(html.includes('Benchmarks are for reference purposes only.'), 'the disclaimer is on the page');
  assert.ok(html.includes('bench-table'), 'speed table rendered');
  for (const text of [...projection.columns.map(column => column.label), 'Parse', 'Stringify', 'Validate']) assert.ok(table.includes(text), `table lacks "${text}"`);
});

// protects: R-30 the speed table draws the projection's numbers, one row for each payload and operation, in column order
test('the built benchmarks page shows the number of each golem setup, and a dash where a setup has no operation', () => {
  assert.ok(existsSync(benchmarksHtml), 'run npm run docs:build first');
  const html = readFileSync(benchmarksHtml, 'utf8').replace(/ data-v-[0-9a-f]+/g, '');
  const start = html.indexOf('<table class="bench-table"');
  const table = html.slice(start, html.indexOf('</table>', start));
  const shown = [...table.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(m => m[1].replace(/<span class="visually-hidden">.*?<\/span>/g, '').replace(/<[^>]*>/g, ''));
  const derived = projection.speeds.flatMap(block => block.rows.flatMap(row => row.cells.map(cell => cell === null ? '\u2014' : Math.round(cell).toLocaleString('en-US'))));
  assert.deepEqual(shown, derived);
  assert.ok(derived.includes('\u2014'), 'the committed results give a dash');
});

// protects: T-246 the cost tab shows the cost table's cells, ratios and dashes in the order of its columns
test('the built benchmarks page has the tab "What each feature costs" with the cost table of the results', () => {
  assert.ok(existsSync(benchmarksHtml), 'run npm run docs:build first');
  const html = readFileSync(benchmarksHtml, 'utf8').replace(/ data-v-[0-9a-f]+/g, '');
  assert.match(html, /role="tab"[^>]*>What each feature costs<\/button>/);
  const start = html.indexOf('<table class="cost-table"');
  const table = html.slice(start, html.indexOf('</table>', start));
  const shown = [...table.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(m => m[1].replace(/<span class="visually-hidden">.*?<\/span>/g, '').replace(/<[^>]*>/g, ''));
  const derived = projection.cost.flatMap(block => block.rows).flatMap(({ cells: r }) => [r.imodelOff, r.imodelOn, r.imodelOnOverOff, r.iobjectOff, r.iobjectOn, r.iobjectOnOverOff, r.imodelOverIobject, r.serdeManyOverNone, r.invalidOverValid]
    .map(c => c.kind === 'ops' ? Math.round(c.value).toLocaleString('en-US') : c.kind === 'ratio' ? `${c.value.toFixed(2)}x` : c.kind === 'not-applicable' ? '\u2014' : 'not run'));
  assert.deepEqual(shown, derived);
  assert.ok(derived.includes('\u2014') && derived.some(cell => cell.endsWith('x')), 'the committed results give both a dash and a ratio');
  const columnHeaders = [...table.matchAll(/<th[^>]*scope="col"[^>]*>/g)].length - 1;
  assert.equal(columnHeaders, Object.keys(projection.cost[0].rows[0].cells).length, 'one column header for each cost column, after the first');
});

test('built pages never render #region markers from imported snippets', () => {
  assert.ok(existsSync(homeHtml), 'run npm run docs:build first');
  const leaks: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (file.endsWith('.html') && /#(?:end)?region\b/.test(readFileSync(file, 'utf8'))) leaks.push(path.relative(dist, file));
    }
  };
  visit(dist);
  assert.deepEqual(leaks, []);
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
