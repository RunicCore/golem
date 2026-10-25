// lane: typescript6 isExpressionStatement and getTrailingCommentRanges of the classic API: the directive prologue is read from statements
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRewrites,
  type FileRewrite,
  type RewriteEdit,
  type RewriteImport,
} from '#golem/rewrite';
import { importInsertOffset } from '#golem/rewrite-scan';
import { ProgramSession } from '#golem/typescript-ns';
import { composeSourceMaps, decodeMappings, encodeMappings, type SourceMapV3 } from '#golem/source-map';

const SERDE = '@exprtlabs/golem/serde';
const CALL = 'parse<TPayment>';
const CALL_TEXT = '__golem_requireObjectCodec("TPayment_ab12cd34").parse';
const IMPORT_LINE = `import { requireObjectCodec as __golem_requireObjectCodec } from '${SERDE}';\n`;

function replace(text: string, original: string, replacement: string, from = 0): RewriteEdit {
  const start = text.indexOf(original, from);
  assert.notEqual(start, -1, `${original} in text`);
  return { start, end: start + original.length, expect: original, text: replacement };
}

function rewriteOf(edits: readonly RewriteEdit[], imports: readonly RewriteImport[] = [], importsAt = 0): FileRewrite {
  return { edits, imports, importsAt };
}

/** Where the scanner puts the imports of `text`: the offset comes from the file's parsed syntax. */
function importsAtOf(text: string): number {
  using session = new ProgramSession({ cwd: process.cwd() });
  return importInsertOffset(session.parseSourceFile('call.ts', text));
}

function callRewrite(text: string): FileRewrite {
  return rewriteOf([replace(text, CALL, CALL_TEXT)], [{ from: SERDE, names: ['requireObjectCodec'] }], importsAtOf(text));
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

test('a call rewrite replaces the call and adds the import; the map names no file and carries the text', () => {
  const text = "const result = parse<TPayment>(text);\n";
  const applied = applyRewrites(text, callRewrite(text));
  assert.equal(applied.code, `${IMPORT_LINE}const result = ${CALL_TEXT}(text);\n`);
  assert.deepEqual(applied.map.sources, ['']);
  assert.deepEqual(applied.map.sourcesContent, [text]);
  assert.equal(applyRewrites('const x = 1;\n', rewriteOf([])).code, 'const x = 1;\n');
});

test('a missing import goes after a shebang and use strict directive', () => {
  const text = "#!/usr/bin/env node\n'use strict';\nparse<TPayment>(text);\n";
  assert.equal(applyRewrites(text, callRewrite(text)).code, `#!/usr/bin/env node\n'use strict';\n${IMPORT_LINE}${CALL_TEXT}(text);\n`);
});

test('the whole directive prologue stays first, whatever the directives are and however they end', () => {
  for (const prologue of [
    "'use client';\n",
    "'use client'\n",
    '"use client";\r\n"use strict";\r\n',
    "'use client'; // runs in the browser\n'use strict';\n",
    "/* header */\n// note\n'use client';\n",
    "#!/usr/bin/env node\n'use client';\n'use strict'\n",
  ]) {
    const text = `${prologue}import { parse } from '${SERDE}';\nconst result = parse<TPayment>(text);\n`;
    assert.equal(applyRewrites(text, callRewrite(text)).code, `${prologue}${IMPORT_LINE}${text.slice(prologue.length).replace('parse<TPayment>', CALL_TEXT)}`, JSON.stringify(prologue));
  }
  // A string that is not a statement of its own is not a directive.
  const expression = "'use client' + suffix;\nparse<TPayment>(text);\n";
  assert.equal(applyRewrites(expression, callRewrite(expression)).code, `${IMPORT_LINE}'use client' + suffix;\n${CALL_TEXT}(text);\n`);
});

test('a directive is a string statement of its own: a comment after it is trivia, an expression it starts is not', () => {
  // protects: T-292 a regex over the text took a string that an expression continues for a directive, and missed a directive with a block comment
  const continued = "'use client'\n  + suffix;\nparse<TPayment>(text);\n";
  assert.equal(applyRewrites(continued, callRewrite(continued)).code, `${IMPORT_LINE}'use client'\n  + suffix;\n${CALL_TEXT}(text);\n`);
  const commented = "'use strict' /* note */\nparse<TPayment>(text);\n";
  assert.equal(applyRewrites(commented, callRewrite(commented)).code, `'use strict' /* note */\n${IMPORT_LINE}${CALL_TEXT}(text);\n`);
  const sameLine = "'use strict'; parse<TPayment>(text);\n";
  assert.equal(applyRewrites(sameLine, callRewrite(sameLine)).code, `'use strict';\n${IMPORT_LINE} ${CALL_TEXT}(text);\n`);
});

test('a module name with a quote or a backslash is escaped in the import line', () => {
  const text = 'const result = 1;\n';
  const imports = [{ from: "./it's\\here.js", names: ['x'] }];
  assert.equal(applyRewrites(text, rewriteOf([], imports)).code, `import { x as __golem_x } from './it\\'s\\\\here.js';\n${text}`);
});

test('overlapping edits, a wrong expectation and an out-of-range edit are an inconsistent rewrite', () => {
  const text = 'const result = parse<TPayment>(text);\n';
  const call = replace(text, CALL, CALL_TEXT);
  const inconsistent = (edits: readonly RewriteEdit[]) => assert.throws(
    () => applyRewrites(text, rewriteOf(edits)),
    (error: unknown) => error instanceof Error && error.message.startsWith('golem rewrite is inconsistent'),
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
  assert.equal(applyRewrites(text, rewriteOf([...around].reverse())).code, `const result = /*a*/${CALL_TEXT}/*b*/(text);\n`);
});

test('an inconsistent rewrite names its file and line when the caller gives the file, in the applier', () => {
  const text = 'const first = 1;\r\nconst result = parse<TPayment>(text);\r\n';
  const wrong = { ...replace(text, CALL, CALL_TEXT), expect: 'parse<TOther>' };
  assert.throws(
    () => applyRewrites(text, rewriteOf([wrong]), 'src/pay.ts'),
    (error: unknown) => error instanceof Error && error.message.startsWith('golem rewrite is inconsistent for src/pay.ts at line 2: ') && error.message.endsWith('run golem generate'),
  );
  assert.throws(
    () => applyRewrites(text, rewriteOf([wrong])),
    (error: unknown) => error instanceof Error && error.message.startsWith('golem rewrite is inconsistent at line 2: '),
  );
});

test('a CRLF file with Vietnamese text maps the rewritten call back to its original line and column', () => {
  const text = '// Thanh toán — đơn hàng\r\nconst result = parse<TPayment>(text);\r\nconst next = 1;\r\n';
  const applied = applyRewrites(text, callRewrite(text));
  assert.equal(applied.code, `${IMPORT_LINE}// Thanh toán — đơn hàng\r\nconst result = ${CALL_TEXT}(text);\r\nconst next = 1;\r\n`);
  assert.deepEqual(originalPosition(applied.code, applied.map, '(text)'), originalPositionOf(text, '(text)'));
  assert.deepEqual(originalPosition(applied.code, applied.map, 'đơn'), originalPositionOf(text, 'đơn'));
  assert.deepEqual(originalPosition(applied.code, applied.map, 'const next'), originalPositionOf(text, 'const next'));
  assert.deepEqual(originalPosition(applied.code, applied.map, 'result ='), originalPositionOf(text, 'result ='));
  assert.deepEqual(originalPosition(applied.code, applied.map, CALL_TEXT), originalPositionOf(text, CALL));
});

test('offsets ignore a leading byte order mark, which stays in the output and out of the map', () => {
  const body = '// Thanh toán — đơn hàng\r\nconst result = parse<TPayment>(text);\r\nconst next = 1;\r\n';
  const text = `﻿${body}`;
  // The compiler reads the file without the mark, so the edit's offsets count from `body`.
  const applied = applyRewrites(text, callRewrite(body));
  assert.equal(applied.code, `﻿${IMPORT_LINE}// Thanh toán — đơn hàng\r\nconst result = ${CALL_TEXT}(text);\r\nconst next = 1;\r\n`);
  assert.deepEqual(applied.map.sourcesContent, [body]);
  assert.equal(applyRewrites(body, callRewrite(body)).code, applied.code.slice(1), 'the text without the mark gives the same code');
  for (const needle of ['(text)', 'đơn', 'const next']) {
    assert.deepEqual(originalPosition(applied.code, applied.map, needle), originalPositionOf(body, needle), needle);
  }
  assert.deepEqual(originalPosition(applied.code, applied.map, CALL_TEXT), originalPositionOf(body, CALL));
});

test('existing imports are never edited: a separate aliased import is added, whatever they contain', () => {
  const clash = `import { parse } from '${SERDE}';\nconst result = parse<TPayment>(text);\n`;
  assert.equal(applyRewrites(clash, callRewrite(clash)).code, `${IMPORT_LINE}import { parse } from '${SERDE}';\nconst result = ${CALL_TEXT}(text);\n`);
  const typeOnly = `import type { TModel } from '${SERDE}';\nconst result = parse<TPayment>(text);\n`;
  assert.equal(applyRewrites(typeOnly, callRewrite(typeOnly)).code, `${IMPORT_LINE}import type { TModel } from '${SERDE}';\nconst result = ${CALL_TEXT}(text);\n`);
  const inlineType = `import { type requireObjectCodec, parse } from '${SERDE}';\nconst result = parse<TPayment>(text);\n`;
  assert.equal(applyRewrites(inlineType, callRewrite(inlineType)).code, `${IMPORT_LINE}${inlineType.replace('parse<TPayment>', CALL_TEXT)}`);
  const sameName = `import { requireObjectCodec } from '${SERDE}';\nconst result = parse<TPayment>(text);\n`;
  assert.equal(applyRewrites(sameName, callRewrite(sameName)).code, `${IMPORT_LINE}${sameName.replace('parse<TPayment>', CALL_TEXT)}`);
});

test('comments, template literals and strings that look like imports stay untouched', () => {
  const text = [
    `import {`,
    `  parse, // the codec entry`,
    `  /* requireObjectCodec, */`,
    `} from '${SERDE}';`,
    'const sample = `',
    `import { parse } from '${SERDE}';`,
    '`;',
    `// import { parse } from '${SERDE}';`,
    `const result = parse<TPayment>(text);`,
    '',
  ].join('\n');
  assert.equal(applyRewrites(text, callRewrite(text)).code, `${IMPORT_LINE}${text.replace('parse<TPayment>', CALL_TEXT)}`);
});

test('a file that ends right after its shebang or directive gets the import on its own line', () => {
  const imports = [{ from: SERDE, names: ['requireObjectCodec'] }];
  for (const text of [
    '#!/usr/bin/env node',
    "'use strict'",
    "#!/usr/bin/env node\n'use strict';",
    "#!/usr/bin/env node\r\n'use strict';\r\n",
  ]) {
    const code = applyRewrites(text, rewriteOf([], imports, importsAtOf(text))).code;
    const lines = code.split(/\r?\n/);
    assert.equal(lines.includes(IMPORT_LINE.trimEnd()), true, JSON.stringify(code));
    assert.equal(code.startsWith(text.split(/\r?\n/)[0]!), true);
    assert.equal(code.endsWith(IMPORT_LINE), true, JSON.stringify(code));
  }
  assert.equal(applyRewrites('#!/usr/bin/env node', rewriteOf([], imports, importsAtOf('#!/usr/bin/env node'))).code, `#!/usr/bin/env node\n${IMPORT_LINE}`);
});

test('one aliased import line is added per entry, and the map stays correct after the prepended lines', () => {
  const text = "'use strict';\r\nconst result = parse<TPayment>(text);\r\nconst next = 1;\r\n";
  const imports = [
    { from: SERDE, names: ['requireObjectCodec', 'registerIModelClass'] },
    { from: '@exprtlabs/golem/model', names: ['IModel'] },
  ];
  const applied = applyRewrites(text, rewriteOf([replace(text, CALL, CALL_TEXT)], imports, importsAtOf(text)));
  assert.equal(
    applied.code,
    "'use strict';\r\n"
      + `import { requireObjectCodec as __golem_requireObjectCodec, registerIModelClass as __golem_registerIModelClass } from '${SERDE}';\n`
      + "import { IModel as __golem_IModel } from '@exprtlabs/golem/model';\n"
      + `const result = ${CALL_TEXT}(text);\r\nconst next = 1;\r\n`,
  );
  for (const needle of ['const result', '(text)', 'const next', 'result =']) {
    assert.deepEqual(originalPosition(applied.code, applied.map, needle), originalPositionOf(text, needle), needle);
  }
  // The prepended lines map to the offset they were inserted at.
  assert.deepEqual(originalPosition(applied.code, applied.map, 'import { IModel'), originalPositionOf(text, 'const result'));
});

test('an insertion maps to its edit start and the lines around it keep their original positions', () => {
  const text = 'class A {}\nexport const a = new Codec(\n  value,\n);\nconst tail = 2;\n';
  const open = text.indexOf('value');
  const edits: RewriteEdit[] = [
    { start: open, end: open, expect: '', text: 'first(),\n  ' },
    { start: text.length - 1, end: text.length - 1, expect: '', text: '// end' },
  ];
  const applied = applyRewrites(text, rewriteOf(edits));
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
  const applied = applyRewrites(original, rewriteOf([replace(original, 'parse<T>', '__golem_requireObjectCodec("T_1").parse')]));
  const rewritten = { code: applied.code, map: { ...applied.map, sources: ['src/x.ts'] } };
  // The compiler dropped the first statement and indented the second by two spaces, naming the staged copy.
  const secondLine = rewritten.code.split('\n')[1]!;
  const outer: SourceMapV3 = {
    version: 3,
    file: 'x.js',
    sources: ['../stage/src/x.ts'],
    names: [],
    mappings: encodeMappings([[
      [2, 0, 1, 0],
      [2 + secondLine.indexOf('__golem_requireObjectCodec'), 0, 1, secondLine.indexOf('__golem_requireObjectCodec')],
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
    [2 + secondLine.indexOf('__golem_requireObjectCodec'), 0, 1, original.split('\n')[1]!.indexOf('parse<T>')],
    [2 + secondLine.indexOf('.parse') + 3, 0, 1, original.split('\n')[1]!.indexOf('parse<T>')],
    [2 + secondLine.indexOf('(v)'), 0, 1, original.split('\n')[1]!.indexOf('(v)')],
    [2 + secondLine.indexOf('v)'), 0, 1, original.split('\n')[1]!.indexOf('v)')],
  ]]);
});
