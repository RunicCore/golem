// lane: typescript6 Checker guards: the controller generator and the rewrite scan read controller parameters through the checker in this process
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import * as ts from '@exprtlabs/golem/internal/ts';
import { arrayItemNode, decoratorIdentity, staticDecoratorKey } from '@exprtlabs/golem/internal/type-analysis';
import { runPipeline } from '#golem/cli';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

const FILES: Readonly<Record<string, string>> = {
  'src/decorators.ts': "export { Query as Filter } from '@nestjs/common';\nexport function Body(): ParameterDecorator { return () => undefined; }\n",
  'src/controller.ts': [
    "import * as nest from '@nestjs/common';",
    "import { Body as Input } from '@nestjs/common';",
    "import { Filter, Body } from './decorators.js';",
    "const KEY = 'k';",
    'declare function keyOf(): string;',
    'declare const pipe: object;',
    'export class C {',
    '  m(',
    '    @Input() whole: string,',
    "    @nest.Body('named') named: string,",
    '    @Filter(KEY) constant: string,',
    '    @Body() local: string,',
    '    @nest.Query(keyOf()) computed: string,',
    '    @nest.Query(pipe) piped: string,',
    '  ) {}',
    '}',
    '',
  ].join('\n'),
  'src/types.ts': [
    'type Item = { id: string };',
    'export type Plain = Item[];',
    'export type Readonly1 = readonly Item[];',
    'export type Generic = Array<Item>;',
    'export type Qualified = globalThis.ReadonlyArray<Item>;',
    'export type Parenthesized = (readonly (Item)[]);',
    'export type Nested = Item[][];',
    'export type NotAnArray = Item;',
    'export type ReadonlyNotAnArray = readonly Item;',
    'export type TwoArguments = Array<Item, Item>;',
    '',
  ].join('\n'),
};

const root = createControllerFixture({ after }, { prefix: 'golem-parameter-readers-', links: 'workspace', files: FILES });
const program = ts.createProgramFromSources({ root, sources: [] });
const checker = program.getTypeChecker();

function decoratorOf(parameterName: string): ts.Decorator {
  const found: ts.Decorator[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === parameterName) found.push(...ts.getDecorators(node) ?? []);
    ts.forEachChild(node, visit);
  };
  const file = program.getSourceFile(path.join(root, 'src/controller.ts'));
  assert.ok(file);
  visit(file);
  assert.equal(found.length, 1, parameterName);
  return found[0]!;
}

test('a decorator is the one its symbol resolves to, under an alias, a namespace or a re-export, and a local one of the same name is not the NestJS one', () => {
  // protects: T-757 F-838 decorator identity by resolved symbol, one definition for the controllers job and the rewrite scan
  assert.deepEqual(['whole', 'named', 'constant', 'local', 'computed'].map(name => decoratorIdentity(checker, decoratorOf(name))), [
    { name: 'Body', packageName: '@nestjs/common' },
    { name: 'Body', packageName: '@nestjs/common' },
    { name: 'Query', packageName: '@nestjs/common' },
    { name: 'Body' },
    { name: 'Query', packageName: '@nestjs/common' },
  ]);
});

test('a decorator key is read only when it is a static string: a computed key, a pipe and no argument name no field', () => {
  // protects: T-757 a computed or non-static decorator key is not read as a field name
  assert.deepEqual(['whole', 'named', 'constant', 'computed', 'piped'].map(name => staticDecoratorKey(checker, decoratorOf(name))), [
    undefined, 'named', 'k', undefined, undefined,
  ]);
});

test('an array type has one item type through parentheses and readonly; any other type has none', () => {
  // protects: T-757 array unwrapping exists once for the controllers job and the rewrite scan
  const file = program.getSourceFile(path.join(root, 'src/types.ts'));
  assert.ok(file);
  const items = file.statements.filter(ts.isTypeAliasDeclaration).filter(alias => alias.name.text !== 'Item')
    .map(alias => [alias.name.text, arrayItemNode(alias.type)?.getText(file)]);
  assert.deepEqual(items, [
    ['Plain', 'Item'], ['Readonly1', 'Item'], ['Generic', 'Item'], ['Qualified', 'Item'], ['Parenthesized', 'Item'],
    ['Nested', 'Item[]'], ['NotAnArray', undefined], ['ReadonlyNotAnArray', undefined], ['TwoArguments', undefined],
  ]);
});

test('the controllers job documents a body field written with a decorator imported under another name or through a re-export', async (t) => {
  // protects: T-757 the controllers job finds a parameter decorator by its resolved symbol
  const project = createControllerFixture(t, {
    prefix: 'golem-aliased-body-',
    links: 'workspace',
    files: {
      'src/payment.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TPayment = IModel<{ id: string }>;\n",
      'src/decorators.ts': "export { Body as Field } from '@nestjs/common';\n",
      'src/a.controller.ts': [
        "import { Controller, Post } from '@nestjs/common';",
        "import { Field } from './decorators.js';",
        "import type { TPayment } from './payment.model.js';",
        "@Controller('a')",
        'export class AController {',
        "  @Post() create(@Field('payment') payment: TPayment): void {}",
        '}',
        '',
      ].join('\n'),
      'golem.yaml': 'version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/a.controller.ts\n    output: generated/api.json\n    openapiVersion: "3.2.0"\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n',
    },
  });
  await runPipeline(path.join(project, 'golem.yaml'));
  const document = JSON.parse(fs.readFileSync(path.join(project, 'generated/api.json'), 'utf8')) as { paths: Record<string, { post: { requestBody: { content: Record<string, { schema: { properties: object } }> } } }> };
  assert.deepEqual(Object.keys(document.paths['/a']!.post.requestBody.content['application/json']!.schema.properties), ['payment']);
});
