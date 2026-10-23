import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BENCH_SERIES_COUNT } from '../scripts/benchmark/cases.js';
import { buildBenchmarkSiteProjection } from '../scripts/benchmark/site-projection.js';
import { PAGE_LINKS } from '../docs/.vitepress/sidebar.js';

const root = path.resolve(import.meta.dirname, '../..');
const docs = path.join(root, 'docs');

function fileFor(link: string): string {
  const clean = link.split('#')[0];
  return path.join(docs, clean.endsWith('/') ? `${clean}index.md` : `${clean}.md`);
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) return ['public', '.vitepress'].includes(e.name) ? [] : markdownFiles(f);
    return f.endsWith('.md') ? [f] : [];
  });
}

test('every page in the inventory exists', () => {
  for (const link of PAGE_LINKS) assert.ok(existsSync(fileFor(link)), `missing page for ${link}`);
});

test('every markdown file under docs/ is in the inventory (no orphans)', () => {
  const listed = new Set(PAGE_LINKS.map(fileFor));
  for (const file of markdownFiles(docs)) assert.ok(listed.has(file), `orphan page ${path.relative(root, file)}`);
});

test('repository markdown links into docs/ resolve', () => {
  const sources = ['README.md', 'CHANGELOG.md', ...readdirSync(path.join(root, 'packages')).map(p => `packages/${p}/README.md`)]
    .filter(f => existsSync(path.join(root, f)));
  for (const source of sources) {
    const text = readFileSync(path.join(root, source), 'utf8');
    for (const match of text.matchAll(/\]\(([^)#\s]*docs\/[^)#\s]+\.md)(#[^)]*)?\)/g)) {
      const target = path.resolve(path.dirname(path.join(root, source)), match[1]);
      assert.ok(existsSync(target), `${source} links to missing ${match[1]}`);
    }
    const pages = new Set(PAGE_LINKS);
    for (const match of text.matchAll(/\]\((\/[a-z][^)#\s]*)(#[^)]*)?\)/g)) {
      assert.ok(pages.has(match[1]), `${source} has a site-absolute link to ${match[1]}, which is not a page`);
    }
  }
});

test('light theme never uses lime as a text color', () => {
  const sources = [
    readFileSync(path.join(docs, '.vitepress/theme/tokens.css'), 'utf8'),
    ...['HomeStage.vue', 'HowItWorks.vue'].map(file => readFileSync(path.join(docs, '.vitepress/theme', file), 'utf8').split('<style')[1] ?? ''),
  ];
  for (const css of sources) {
    for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const darkOnly = selectors.split(',').every(sel => /^\s*(\.dark\b|:global\(\.dark\))/.test(sel));
      if (darkOnly) continue;
      assert.doesNotMatch(body, /(^|[;\s])(-webkit-text-fill-)?color:\s*(var\(--cg-lime\)|#a3e635)/i, `lime text in light rule: ${selectors.trim()}`);
    }
  }
});

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function themePalettes(): { light: Map<string, string>; dark: Map<string, string> } {
  const tokens = readFileSync(path.join(docs, '.vitepress/theme/tokens.css'), 'utf8');
  const vars = (block: string): Map<string, string> => new Map([...block.matchAll(/(--cg-[a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
  const light = vars(tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('}', tokens.indexOf(':root {'))));
  const darkStart = tokens.indexOf('.dark {');
  return { light, dark: new Map([...light, ...vars(tokens.slice(darkStart, tokens.indexOf('}', darkStart)))]) };
}

test('home stage, how-it-works text (4.5:1) and benchmark series colors (3:1) are legible on the panel in both themes', () => {
  const { light, dark } = themePalettes();
  const style = ['HomeStage.vue', 'HowItWorks.vue'].map(file => readFileSync(path.join(docs, '.vitepress/theme', file), 'utf8').split('<style')[1] ?? '').join('\n');
  const textColors = [...new Set([...style.matchAll(/(?:^|[;{\s])color:\s*var\((--cg-[a-z0-9-]+)\)/g)].map(m => m[1]))];
  const seriesColors = Array.from({ length: BENCH_SERIES_COUNT }, (_, index) => `--cg-series-${index + 1}`);
  for (const [theme, palette] of [['light', light], ['dark', dark]] as const) {
    for (const [names, minimum] of [[textColors, 4.5], [seriesColors, 3]] as const) {
      for (const name of names) {
        const fg = palette.get(name), bg = palette.get('--cg-panel');
        assert.ok(fg && bg, `${theme}: ${name} or --cg-panel undefined`);
        assert.ok(contrast(fg, bg) >= minimum, `${theme}: ${name} ${fg} on ${bg} is ${contrast(fg, bg).toFixed(2)}:1, needs ${minimum}:1`);
      }
    }
    assert.equal(new Set(seriesColors.map(name => palette.get(name))).size, seriesColors.length, `${theme}: series colors differ`);
  }
});

test('each golem setup on the benchmarks page has its own series color', () => {
  const { columns } = buildBenchmarkSiteProjection(root);
  assert.ok(columns.length <= BENCH_SERIES_COUNT, `the page shows ${columns.length} golem setups and defines ${BENCH_SERIES_COUNT} series colors`);
});

test('the guide index mounts the How it works illustration', () => {
  assert.match(readFileSync(path.join(docs, 'guide/index.md'), 'utf8'), /## How it works\n\n<HowItWorks \/>\n/);
});

test('the benchmark page is disclaimed, shown by tabs, and explained in markdown', () => {
  const page = readFileSync(path.join(docs, 'benchmarks.md'), 'utf8');
  assert.match(page, /Benchmarks are for reference purposes only\./);
  assert.match(page, /<template #speed>/, 'explanation of the speed table');
  const chart = readFileSync(path.join(docs, '.vitepress/theme/BenchmarkChart.vue'), 'utf8');
  assert.match(chart, /role="tablist"/);
  assert.match(chart, /role="tab"/);
  assert.match(chart, /<slot name="speed"/, 'the explanation comes from the page');
});

// protects: R-30 the page shows golem's own declarations and timed calls, for each payload it shows numbers for
test('the benchmarks page shows, per payload, the declarations and timed calls of each golem setup it times', () => {
  const page = readFileSync(path.join(docs, 'benchmarks.md'), 'utf8');
  const { columns, speeds } = buildBenchmarkSiteProjection(root);
  const chart = readFileSync(path.join(docs, '.vitepress/theme/BenchmarkChart.vue'), 'utf8');
  assert.match(chart, /<slot :name="`\$\{payload\.id\}-code`"/, 'the chart renders one code slot per payload');
  for (const { payload, rows } of speeds) {
    const start = page.indexOf(`<template #${payload.id}-code>`);
    assert.ok(start >= 0, `code for ${payload.id}`);
    const block = page.slice(start, page.indexOf('</template>', start));
    // The IModel setups share one declaration and one call snippet.
    const timed = columns.filter((_, index) => rows.some(row => row.cells[index] !== null));
    for (const label of new Set(timed.map(column => column.label.startsWith('Golem (IModel') ? 'Golem (IModel)' : column.label))) {
      assert.equal(block.split(`[${label}]`).length - 1, 2, `${payload.id}: declarations and calls for ${label}`);
    }
  }
  for (const [, file, region] of page.matchAll(/^<<< @\/(\S+?)#(\S+)/gm)) {
    const source = readFileSync(path.join(docs, file), 'utf8');
    assert.match(source, new RegExp(`// #region ${region}\\b[\\s\\S]*// #endregion ${region}\\b`), `${file} has region ${region}`);
  }
});

/** `typescript` is declared as `>=A.B.C <D`; an install command pins a tilde range. */
function admits(peer: string, range: string): boolean {
  const bounds = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(peer);
  const version = /^~(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!bounds || !version) return false;
  const [low, high] = [bounds.slice(1, 4).map(Number), Number(bounds[4])];
  const found = version.slice(1, 4).map(Number);
  const atLeastLow = found[0] !== low[0] ? found[0] > low[0] : found[1] !== low[1] ? found[1] > low[1] : found[2] >= low[2];
  return atLeastLow && found[0] < high;
}

test('install commands pin a typescript inside the peer range', () => {
  const peers = JSON.parse(readFileSync(path.join(root, 'packages/golem-model/package.json'), 'utf8')).peerDependencies as Record<string, string>;
  const files = [...markdownFiles(docs), path.join(root, 'README.md'), ...readdirSync(path.join(root, 'packages')).map(p => path.join(root, 'packages', p, 'README.md'))].filter(existsSync);
  const wrong: string[] = [];
  for (const file of files) {
    for (const [line] of readFileSync(file, 'utf8').matchAll(/^npm install .*$/gm)) {
      for (const [, name, range] of line.matchAll(/\b(typescript)@(\S+)/g)) {
        if (!(range === '~7.0.2' && admits(peers[name], range))) wrong.push(`${path.relative(root, file)}: ${name}@${range} (peer ${peers[name]})`);
      }
    }
  }
  assert.deepEqual(wrong, []);
});

// Pages whose TypeScript stays inline, with the reason. Empty: every guide page imports its code.
const INLINE_CODE_ALLOWED: Readonly<Record<string, number>> = {};

test('guide TypeScript is imported except on listed pages', () => {
  const over: string[] = [];
  for (const page of markdownFiles(path.join(docs, 'guide'))) {
    const rel = path.relative(docs, page);
    const count = (readFileSync(page, 'utf8').match(/^```(?:ts|tsx|typescript)\b/gm) ?? []).length;
    if (count > (INLINE_CODE_ALLOWED[rel] ?? 0)) over.push(`${rel}: ${count} inline TypeScript blocks`);
  }
  assert.deepEqual(over, []);
});

test('the runtime reference has a table row, and a runtime or generator reference a section, for every public @exprtlabs/golem subpath', () => {
  // protects: F-41 the public subpath list lives in one table that follows package.json
  const exports = Object.keys(JSON.parse(readFileSync(path.join(root, 'packages/golem/package.json'), 'utf8')).exports as Record<string, unknown>).map(key => key.replace(/^\.\//, ''));
  const page = readFileSync(path.join(docs, 'reference/runtime-api.md'), 'utf8');
  const sections = page + readFileSync(path.join(docs, 'reference/generator-api.md'), 'utf8');
  for (const subpath of exports.filter(name => !name.startsWith('internal/'))) {
    assert.match(page, new RegExp(`^\\| \\[\`${subpath}\`\\]`, 'm'), `no table row for ${subpath}`);
    assert.match(sections, new RegExp(`^## \`@exprtlabs/golem/${subpath}\``, 'm'), `no section for ${subpath}`);
  }
});

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(f) : f.endsWith('.ts') ? [f] : [];
  });
}

function emittedDiagnosticCodes(): Record<'NEST' | 'RUNM' | 'OPENAPI', string[]> {
  const nest = [...readFileSync(path.join(root, 'packages/golem-ts-openapi/src/diagnostics.ts'), 'utf8').matchAll(/= '(NEST\d{4})'/g)].map(m => m[1]);
  const runm = tsFiles(path.join(root, 'packages/golem/src/tooling/type-analysis'))
    .flatMap(f => [...readFileSync(f, 'utf8').matchAll(/\bdiagnostic\([^;]*?'(\d{4})'/gs)].map(m => `RUNM${m[1]}`));
  const scan = ['rewrite-scan.ts', 'config.ts']
    .flatMap(f => [...readFileSync(path.join(root, 'packages/golem/src/tooling', f), 'utf8').matchAll(/= '(RUNM\d{4})'/g)].map(m => m[1]));
  const openapi = tsFiles(path.join(root, 'packages/golem-openapi/src'))
    .flatMap(f => [...readFileSync(f, 'utf8').matchAll(/'(OPENAPI_[A-Z_]+)'/g)].map(m => m[1]));
  return { NEST: [...new Set(nest)], RUNM: [...new Set([...runm, ...scan])], OPENAPI: [...new Set(openapi)] };
}

test('the diagnostics page lists every code the generators emit', () => {
  const page = readFileSync(path.join(docs, 'reference/diagnostics.md'), 'utf8');
  const missing = Object.values(emittedDiagnosticCodes())
    .flat()
    .filter(code => !new RegExp(`^### ${code}$`, 'm').test(page));
  assert.deepEqual(missing, []);
});

const INTERNAL_SDK_PATH = /sdk\/(?:client|client-runtime|validation|models|schemas|types|input-schemas|output-schemas)\.(?:js|ts)\b|sdk\/models\/_group-|sdk\/validation-schemas\//;

test('docs and READMEs import only public SDK paths', () => {
  const files = [
    ...markdownFiles(docs),
    path.join(root, 'README.md'),
    ...readdirSync(path.join(root, 'packages')).map(p => path.join(root, 'packages', p, 'README.md')),
  ].filter(existsSync);
  const offenders = files
    .filter(file => !/\.generated\.ts$/.test(file) && INTERNAL_SDK_PATH.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(root, file));
  assert.deepEqual(offenders, []);
});
