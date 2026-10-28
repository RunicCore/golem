// lane: typescript6 Checker guards: the controller generator and the rewrite code it uses run the checker in this process
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import * as ts from '@exprtlabs/golem/internal/ts';
import { unwrapAsyncType } from '#controllers/nest/analysis-utils';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

test('unwrapAsyncType keeps the type argument node only when the syntax spells the wrapper', t => {
  const root = createControllerFixture(t, {
    prefix: 'golem-async-unwrap-',
    links: 'none',
    files: {
      'src/returns.ts': [
        'export class Item { id!: string; }',
        'type Page<T> = Promise<T[]>;',
        'export declare function direct(): Promise<Item>;',
        'export declare function aliased(): Page<Item>;',
        '',
      ].join('\n'),
    },
  });
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
