import { createFixtureProject, writeGeneratedArtifacts } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import * as ts from '@exprtlabs/golem/ts';
import { unwrapAsyncType } from '#controllers/nest/analysis-utils';

test('unwrapAsyncType keeps the type argument node only when the syntax spells the wrapper', t => {
  const root = createFixtureProject(t, 'golem-async-unwrap-');
  writeGeneratedArtifacts([
    { path: path.join(root, 'package.json'), content: '{ "type": "module" }\n' },
    {
      path: path.join(root, 'tsconfig.json'),
      content: `${JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true }, include: ['src/**/*.ts'] })}\n`,
    },
    {
      path: path.join(root, 'src/returns.ts'),
      content: [
        'export class Item { id!: string; }',
        'type Page<T> = Promise<T[]>;',
        'export declare function direct(): Promise<Item>;',
        'export declare function aliased(): Page<Item>;',
        '',
      ].join('\n'),
    },
  ]);
  const program = ts.createProgramFromSources({ root, sources: [] });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(path.join(root, 'src/returns.ts'));
  assert.ok(sourceFile);
  const unwrapped = (name: string): ReturnType<typeof unwrapAsyncType> => {
    const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
    ));
    assert.ok(declaration?.type);
    const returnType = checker.getSignatureFromDeclaration(declaration)?.getReturnType();
    assert.ok(returnType);
    return unwrapAsyncType(checker, returnType, declaration.type);
  };
  const direct = unwrapped('direct');
  assert.equal(checker.typeToString(direct.type), 'Item');
  assert.equal(direct.node?.getText(), 'Item');
  const aliased = unwrapped('aliased');
  assert.equal(checker.typeToString(aliased.type), 'Item[]');
  assert.equal(aliased.node, undefined, 'the alias argument `Item` does not describe the unwrapped `Item[]`');
});
