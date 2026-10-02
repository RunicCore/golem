import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyRewrites,
  GolemRewriteStaleError,
  readRewriteIndex,
  sha256Hex,
  type RewriteEdit,
  type RewriteFile,
  type RewriteImport,
  type RewriteIndex,
} from '#golem/rewrite';
import { composeSourceMaps, decodeMappings, encodeMappings, type SourceMapV3 } from '#golem/source-map';
import { GOLEM_VERSION } from '#golem/version';

const SERDE = '@exprtlabs/golem/serde';
const CALL = 'parse<TPayment>';
const CALL_TEXT = 'requireObjectCodec("TPayment_ab12cd34").parse';

function replace(text: string, original: string, replacement: string, from = 0): RewriteEdit {
  const start = text.indexOf(original, from);
  assert.notEqual(start, -1, `${original} in text`);
  return { start, end: start + original.length, expect: original, text: replacement };
}

function indexFor(file: string, text: string, edits: readonly RewriteEdit[], imports: readonly RewriteImport[] = [], overrides: Partial<RewriteFile> = {}): RewriteIndex {
  return { version: 1, golem: GOLEM_VERSION, files: { [file]: { sha256: sha256Hex(text), edits, imports, ...overrides } } };
}

function callRewrite(file: string, text: string): RewriteIndex {
  return indexFor(file, text, [replace(text, CALL, CALL_TEXT)], [{ from: SERDE, names: ['requireObjectCodec'] }]);
}

/** Original `[line, column]` of the first `needle` in the generated code, resolved through the map's segments. */
function originalPosition(code: string, map: SourceMapV3, needle: string): [number, number] {
  const offset = code.indexOf(needle);
  assert.notEqual(offset, -1, `${needle} in code`);
  const before = code.slice(0, offset).split(/\r\n|\n/);
  const line = before.length - 1;
  const column = before[line]!.length;
  const segments = decodeMappings(map.mappings)[line] ?? [];
  const segment = [...segments].reverse().find((candidate) => candidate[0]! <= column);
  assert.ok(segment && segment.length >= 4, `a segment at or before generated ${line}:${column}`);
  return [segment[2]!, segment[3]! + column - segment[0]!];
}

function originalPositionOf(text: string, needle: string): [number, number] {
  const before = text.slice(0, text.indexOf(needle)).split(/\r\n|\n/);
  return [before.length - 1, before[before.length - 1]!.length];
}

test('a call rewrite replaces the call and adds the import; an untouched file is left alone', () => {
  const text = "const result = parse<TPayment>(text);\n";
  const index = callRewrite('src/pay.ts', text);
  const applied = applyRewrites('src/pay.ts', text, index);
  assert.equal(applied?.code, `import { requireObjectCodec } from '${SERDE}';\nconst result = ${CALL_TEXT}(text);\n`);
  assert.deepEqual(applied?.map.sources, ['src/pay.ts']);
  assert.deepEqual(applied?.map.sourcesContent, [text]);
  assert.equal(applyRewrites('src/other.ts', 'const x = 1;\n', index), undefined);
});

test('a missing import goes after a shebang and use strict directive', () => {
  const text = "#!/usr/bin/env node\n'use strict';\nparse<TPayment>(text);\n";
  const applied = applyRewrites('bin/pay.ts', text, callRewrite('bin/pay.ts', text));
  assert.equal(applied?.code, `#!/usr/bin/env node\n'use strict';\nimport { requireObjectCodec } from '${SERDE}';\n${CALL_TEXT}(text);\n`);
});

test('a stale hash or a different golem version is a stale-index error naming the fix', () => {
  const text = 'const result = parse<TPayment>(text);\n';
  const index = callRewrite('src/pay.ts', text);
  assert.throws(
    () => applyRewrites('src/pay.ts', `${text}// edited\n`, index),
    (error: unknown) => error instanceof GolemRewriteStaleError
      && error.file === 'src/pay.ts'
      && error.message === 'src/pay.ts changed after golem generate; run golem generate, or keep golem watch running.',
  );
  assert.throws(
    () => applyRewrites('src/pay.ts', text, { ...index, golem: '0.0.1' }),
    (error: unknown) => error instanceof GolemRewriteStaleError && error.message === 'rewrite index was written by golem 0.0.1; run golem generate',
  );
});

test('overlapping edits, a wrong expectation and an out-of-range edit are an inconsistent index', () => {
  const text = 'const result = parse<TPayment>(text);\n';
  const call = replace(text, CALL, CALL_TEXT);
  const expected = 'golem rewrite index is inconsistent for src/pay.ts';
  const inconsistent = (edits: readonly RewriteEdit[]) => assert.throws(
    () => applyRewrites('src/pay.ts', text, indexFor('src/pay.ts', text, edits)),
    (error: unknown) => !(error instanceof GolemRewriteStaleError) && error instanceof Error && error.message === expected,
  );
  inconsistent([call, { ...call, start: call.start + 2, end: call.end - 2, expect: CALL.slice(2, -2) }]);
  inconsistent([call, call]);
  inconsistent([{ ...call, expect: 'parse<TOther>' }]);
  inconsistent([{ start: text.length, end: text.length + 3, expect: '', text: 'x' }]);
  // An insertion at a replacement's start is fine, and so is one at its end.
  const around = [
    { start: call.start, end: call.start, expect: '', text: '/*a*/' },
    call,
    { start: call.end, end: call.end, expect: '', text: '/*b*/' },
  ];
  assert.equal(applyRewrites('src/pay.ts', text, indexFor('src/pay.ts', text, [...around].reverse()))?.code, `const result = /*a*/${CALL_TEXT}/*b*/(text);\n`);
});

test('a CRLF file with Vietnamese text maps the rewritten call back to its original line and column', () => {
  const text = '// Thanh toán — đơn hàng\r\nconst result = parse<TPayment>(text);\r\nconst next = 1;\r\n';
  const applied = applyRewrites('src/pay.ts', text, callRewrite('src/pay.ts', text));
  assert.ok(applied);
  assert.equal(applied.code, `import { requireObjectCodec } from '${SERDE}';\n// Thanh toán — đơn hàng\r\nconst result = ${CALL_TEXT}(text);\r\nconst next = 1;\r\n`);
  assert.deepEqual(originalPosition(applied.code, applied.map, '(text)'), originalPositionOf(text, '(text)'));
  assert.deepEqual(originalPosition(applied.code, applied.map, 'đơn'), originalPositionOf(text, 'đơn'));
  assert.deepEqual(originalPosition(applied.code, applied.map, 'const next'), originalPositionOf(text, 'const next'));
  assert.deepEqual(originalPosition(applied.code, applied.map, 'result ='), originalPositionOf(text, 'result ='));
  assert.deepEqual(originalPosition(applied.code, applied.map, CALL_TEXT), originalPositionOf(text, CALL));
});

test('an existing serde import gains the name; a type-only import is not merged into', () => {
  const merged = `import { parse } from '${SERDE}';\nconst result = parse<TPayment>(text);\n`;
  assert.equal(
    applyRewrites('a.ts', merged, callRewrite('a.ts', merged))?.code,
    `import { parse, requireObjectCodec } from '${SERDE}';\nconst result = ${CALL_TEXT}(text);\n`,
  );
  const doubleQuoted = `import {\n  parse,\n} from "${SERDE}";\nconst result = parse<TPayment>(text);\n`;
  assert.equal(
    applyRewrites('b.ts', doubleQuoted, callRewrite('b.ts', doubleQuoted))?.code,
    `import {\n  parse, requireObjectCodec,\n} from "${SERDE}";\nconst result = ${CALL_TEXT}(text);\n`,
  );
  const alreadyThere = `import { requireObjectCodec as codec, parse } from '${SERDE}';\nconst result = parse<TPayment>(text);\n`;
  assert.equal(
    applyRewrites('c.ts', alreadyThere, callRewrite('c.ts', alreadyThere))?.code,
    `import { requireObjectCodec as codec, parse, requireObjectCodec } from '${SERDE}';\nconst result = ${CALL_TEXT}(text);\n`,
  );
  const typeOnly = `import type { TModel } from '${SERDE}';\nconst result = parse<TPayment>(text);\n`;
  assert.equal(
    applyRewrites('d.ts', typeOnly, callRewrite('d.ts', typeOnly))?.code,
    `import { requireObjectCodec } from '${SERDE}';\nimport type { TModel } from '${SERDE}';\nconst result = ${CALL_TEXT}(text);\n`,
  );
});

test('an insertion maps to its edit start and the lines around it keep their original positions', () => {
  const text = 'class A {}\nexport const a = new Codec(\n  value,\n);\nconst tail = 2;\n';
  const open = text.indexOf('value');
  const edits: RewriteEdit[] = [
    { start: open, end: open, expect: '', text: 'first(),\n  ' },
    { start: text.length - 1, end: text.length - 1, expect: '', text: '// end' },
  ];
  const applied = applyRewrites('src/a.ts', text, indexFor('src/a.ts', text, edits));
  assert.ok(applied);
  assert.equal(applied.code, 'class A {}\nexport const a = new Codec(\n  first(),\n  value,\n);\nconst tail = 2;// end\n');
  assert.deepEqual(originalPosition(applied.code, applied.map, 'first()'), originalPositionOf(text, 'value'));
  assert.deepEqual(originalPosition(applied.code, applied.map, 'value'), originalPositionOf(text, 'value'));
  assert.deepEqual(originalPosition(applied.code, applied.map, ');\nconst'), originalPositionOf(text, ');\nconst'));
  assert.deepEqual(originalPosition(applied.code, applied.map, 'const tail'), originalPositionOf(text, 'const tail'));
});

test('source map mappings round trip through encode and decode', () => {
  const lines = [[[0, 0, 0, 0], [7, 0, 0, 4], [30, 1, 3, 200]], [], [[2, 1, 2, 1]], [[0, 0, 40, 0]]] as const;
  assert.deepEqual(decodeMappings(encodeMappings(lines)), lines);
  assert.equal(encodeMappings([[[0, 0, 0, 0]], [[1, 0, 1, 1]]]), 'AAAA;CACC');
  assert.deepEqual(decodeMappings('AAAAA,CAAC,E'), [[[0, 0, 0, 0, 0], [1, 0, 0, 1], [3]]]);
});

test('composing maps resolves an output position to the original, whatever the outer map names its source', () => {
  const original = 'const a = 1;\nconst x = parse<T>(v);\n';
  const index = indexFor('src/x.ts', original, [replace(original, 'parse<T>', 'requireObjectCodec("T_1").parse')]);
  const rewritten = applyRewrites('src/x.ts', original, index);
  assert.ok(rewritten);
  // The compiler dropped the first statement and indented the second by two spaces, naming the staged copy.
  const secondLine = rewritten.code.split('\n')[1]!;
  const outer: SourceMapV3 = {
    version: 3,
    file: 'x.js',
    sources: ['../stage/src/x.ts'],
    names: [],
    mappings: encodeMappings([[
      [2, 0, 1, 0],
      [2 + secondLine.indexOf('requireObjectCodec'), 0, 1, secondLine.indexOf('requireObjectCodec')],
      [2 + secondLine.indexOf('.parse') + 3, 0, 1, secondLine.indexOf('.parse') + 3],
      [2 + secondLine.indexOf('(v)'), 0, 1, secondLine.indexOf('(v)')],
      [2 + secondLine.indexOf('v)'), 0, 1, secondLine.indexOf('v)')],
    ]]),
  };
  const composed = composeSourceMaps(outer, rewritten.map);
  assert.deepEqual(composed.sources, ['src/x.ts']);
  assert.deepEqual(composed.sourcesContent, [original]);
  assert.equal(composed.file, 'x.js');
  assert.deepEqual(decodeMappings(composed.mappings), [[
    [2, 0, 1, 0],
    [2 + secondLine.indexOf('requireObjectCodec'), 0, 1, original.split('\n')[1]!.indexOf('parse<T>')],
    [2 + secondLine.indexOf('.parse') + 3, 0, 1, original.split('\n')[1]!.indexOf('parse<T>')],
    [2 + secondLine.indexOf('(v)'), 0, 1, original.split('\n')[1]!.indexOf('(v)')],
    [2 + secondLine.indexOf('v)'), 0, 1, original.split('\n')[1]!.indexOf('v)')],
  ]]);
});

test('readRewriteIndex reads .golem/rewrites.json, reports a missing file as undefined and rejects a malformed one', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-rewrite-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readRewriteIndex(root), undefined);
  const text = 'const result = parse<TPayment>(text);\n';
  const index = callRewrite('src/pay.ts', text);
  fs.mkdirSync(path.join(root, '.golem'));
  fs.writeFileSync(path.join(root, '.golem', 'rewrites.json'), JSON.stringify(index));
  assert.deepEqual(readRewriteIndex(root), index);
  fs.writeFileSync(path.join(root, '.golem', 'rewrites.json'), JSON.stringify({ ...index, version: 2 }));
  assert.throws(() => readRewriteIndex(root), /malformed; run golem generate/);
  fs.writeFileSync(path.join(root, '.golem', 'rewrites.json'), '{');
  assert.throws(() => readRewriteIndex(root), /malformed; run golem generate/);
});

test('GOLEM_VERSION equals the golem package version', () => {
  const { version } = JSON.parse(fs.readFileSync(new URL('../../packages/golem/package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(GOLEM_VERSION, version);
});
