import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const docs = path.resolve(import.meta.dirname, '../../docs');
const BANNED: readonly [RegExp, string][] = [
  [/IModel child class/i, 'say "your class"; see the IObject/IModel terminology'],
  [/\bchild class/i, 'say "your class"'],
  [/[.!?]\s+your class\b/, 'sentence starts with lowercase "your class"'],
  [/<span id=/, 'legacy anchor span'],
  [/\bthis (guide|page) (shows|explains|describes|covers)\b/i, 'preamble; say what the reader does'],
  [/<(ContractFlow|ContractExamples|DocDiagram|SerdeCallTable|SerdeBenchmarks|ComparisonCatalog)\b/, 'removed component'],
  [/\b(simply|just|easily|seamlessly|robust|leverage|powerful)\b/i, 'filler word'],
  [/^#+ Next steps\b/m, 'signpost heading; link inline instead'],
  [/\bcurrently supports?\b/i, 'hedge; state what is supported'],
  [/\ba base class for your class\b/i, 'say "the generated class (TaskBase) that your class extends"'],
];

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) return ['public', '.vitepress'].includes(e.name) ? [] : pages(f);
    return f.endsWith('.md') ? [f] : [];
  });
}

/** Markdown with fenced code, inline code and HTML comments removed; code may use any words. */
function prose(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^<<<.*$/gm, '').replace(/`[^`\n]*`/g, '');
}

test('docs follow the voice rules', () => {
  const problems: string[] = [];
  for (const file of pages(docs)) {
    const text = prose(readFileSync(file, 'utf8'));
    for (const [pattern, why] of BANNED) {
      for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
        problems.push(`${path.relative(docs, file)}: "${match[0]}" — ${why}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('guide pages open with a title and one sentence', () => {
  const guides = pages(path.join(docs, 'guide'));
  assert.ok(guides.length > 0, 'docs/guide has no pages');
  for (const file of guides) {
    const body = readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\n/, '').trimStart();
    const [title, , first] = body.split('\n');
    assert.match(title, /^# \S/, `${file}: first line must be the title`);
    assert.ok(first && !first.startsWith('#') && !first.startsWith('<<<') && first.length <= 220, `${file}: second paragraph must be one short sentence`);
    assert.match(first ?? '', /[.!?]$/, `${file}: second paragraph must be exactly one sentence`);
    assert.doesNotMatch((first ?? '').slice(0, -1), /[.!?]\s/, `${file}: second paragraph must be exactly one sentence`);
  }
});

const REVIEW_RULES: readonly [RegExp, string][] = [
  [/(?:^(?:For more|To learn more|Start with)\s+\[|\bSee\s+(?:the\s+)?(?:\w+\s+)?\[)/im, 'signpost; link inline instead'],
  [/\]\([^)]*\)\s+(?:covers|explains|compares|lists|describes)\b/, 'signpost; link inline instead'],
  [/^Continue with\b/m, 'signpost; link inline instead'],
  [/\b(?:companion|projections?|interned|object plane|model plane|codec ids?|API object|generated-model branch|union factory|protocol checks|canonical essence|handwritten class|ownership inventory|native backend|stream claims)\b/i, 'internal vocabulary; say what the reader sees or does'],
];

test('docs avoid signposts and internal vocabulary', () => {
  const problems: string[] = [];
  for (const file of pages(docs)) {
    const rel = path.relative(docs, file);
    const text = prose(readFileSync(file, 'utf8'));
    for (const [pattern, why] of REVIEW_RULES) {
      for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
        problems.push(`${rel}: "${match[0]}" — ${why}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
