import { writeGeneratedArtifacts } from '../fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import * as ts from '@exprtlabs/codegen/ts';
import { evaluateStaticValue } from '#controllers/evaluation/static-value';

const FILES: Readonly<Record<string, string>> = {
  'src/enums.ts': [
    "export enum Order { Asc = 'asc', Desc = 'desc' }",
    'export enum Level { Low = 1, High = 2 }',
    "export enum Merged { A = 'a' }",
    "export enum Merged { B = 'b' }",
    '',
  ].join('\n'),
  'src/consts.ts': "export const PREFIX = 'api';\n",
  'src/barrel.ts': "export { Order as SortOrder } from './enums.js';\nexport * from './consts.js';\n",
  'src/values.ts': [
    "import { SortOrder, PREFIX } from './barrel.js';",
    "import * as enums from './enums.js';",
    "import { Level, Merged } from './enums.js';",
    "const KEY = 'b';",
    "const MAP = { a: 1, b: 2, asc: 'ascending' } as const;",
    'export const ELEMENT_CONST_KEY = MAP[KEY];',
    'export const ELEMENT_ENUM_KEY = MAP[SortOrder.Asc];',
    "export const ELEMENT_LITERAL_KEY = MAP['a'];",
    "export const ENUM_LITERAL_KEY = Level['High'];",
    'const BASE = { a: 1, b: 1 };',
    'export const SPREAD_ORDER = { a: 0, ...BASE, b: 2 };',
    'export const REEXPORTED = [SortOrder.Asc, PREFIX, enums.Level.Low];',
    'export const WHOLE_ENUM = SortOrder;',
    'export const NUMERIC_AS_CONST = { low: Level.Low } as const;',
    'export const MERGED_ENUM = Merged;',
    'export const TEMPLATE = `${PREFIX}/v${Level.High}`;',
    "export const CONCAT = PREFIX + '-' + 1;",
    "export const PROTO_KEY = { ['__proto__']: 'x' };",
    'export const SIGNED = [-1, +2] satisfies number[];',
    "let mutable = 'x';",
    "mutable = 'y';",
    'export const FROM_LET = mutable;',
    "let mutableObject = { a: 'x' };",
    'mutableObject = { a: "y" };',
    'export const LET_MEMBER = mutableObject.a;',
    'export const CALL = String(1);',
    'export const UNDEFINED_VALUE = undefined;',
    'function helper(): string { return "x"; }',
    'export const FUNCTION_VALUE = helper;',
    'export const SELF: unknown = { self: SELF };',
    '',
  ].join('\n'),
};

// One Program serves every test in this file: the fixture files are read-only inputs.
function createEvaluator(): (name: string) => ReturnType<typeof evaluateStaticValue> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runic-static-value-')));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeGeneratedArtifacts([
    { path: path.join(root, 'package.json'), content: '{ "type": "module" }\n' },
    {
      path: path.join(root, 'tsconfig.json'),
      content: `${JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true }, include: ['src/**/*.ts'] })}\n`,
    },
    ...Object.entries(FILES).map(([relative, content]) => ({ path: path.join(root, relative), content })),
  ]);
  const program = ts.createProgramFromSources({ root, sources: [] });
  const sourceFile = program.getSourceFile(path.join(root, 'src/values.ts'));
  assert.ok(sourceFile);
  const initializers = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  const checker = program.getTypeChecker();
  return name => {
    const expression = initializers.get(name);
    assert.ok(expression, name);
    return evaluateStaticValue(checker, expression);
  };
}

const evaluate = createEvaluator();

function valueOf(result: ReturnType<typeof evaluateStaticValue>): unknown {
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return result.ok ? result.value : undefined;
}

test('reads const and enum element keys as keys, not as the member value', () => {
  assert.equal(valueOf(evaluate('ELEMENT_CONST_KEY')), 2);
  assert.equal(valueOf(evaluate('ELEMENT_ENUM_KEY')), 'ascending');
  assert.equal(valueOf(evaluate('ELEMENT_LITERAL_KEY')), 1);
  assert.equal(valueOf(evaluate('ENUM_LITERAL_KEY')), 2);
});

test('applies object spreads in source order and keeps __proto__ as an own key', () => {
  assert.deepEqual(valueOf(evaluate('SPREAD_ORDER')), { a: 1, b: 2 });
  const proto = valueOf(evaluate('PROTO_KEY'));
  assert.ok(proto !== null && typeof proto === 'object');
  assert.equal(Object.hasOwn(proto, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});

test('follows re-exported enums and consts across files, merged enums and as const', () => {
  assert.deepEqual(valueOf(evaluate('REEXPORTED')), ['asc', 'api', 1]);
  assert.deepEqual(valueOf(evaluate('WHOLE_ENUM')), ['asc', 'desc']);
  assert.deepEqual(valueOf(evaluate('NUMERIC_AS_CONST')), { low: 1 });
  assert.deepEqual(valueOf(evaluate('MERGED_ENUM')), ['a', 'b']);
});

test('folds template and + concatenation and signed numbers', () => {
  assert.equal(valueOf(evaluate('TEMPLATE')), 'api/v2');
  assert.equal(valueOf(evaluate('CONCAT')), 'api-1');
  assert.deepEqual(valueOf(evaluate('SIGNED')), [-1, 2]);
});

test('reports let/var bindings, calls, undefined, functions and self-reference as unresolvable', () => {
  const reasons: Readonly<Record<string, RegExp>> = {
    FROM_LET: /mutable is not declared with const/,
    LET_MEMBER: /mutableObject is not declared with const/,
    CALL: /calls are evaluated at runtime/,
    UNDEFINED_VALUE: /undefined is not a JSON value/,
    FUNCTION_VALUE: /helper is not a const value/,
    SELF: /refers to itself/,
  };
  for (const [name, reason] of Object.entries(reasons)) {
    const result = evaluate(name);
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.match(result.reason, reason, name);
  }
});
