// lane: typescript6 Checker guards: the controller generator and the rewrite code it uses run the checker in this process
import { createFixtureProject, readFixture, writeGeneratedArtifacts } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import * as ts from '@exprtlabs/golem/internal/ts';
import { evaluateRouteExpression } from '#controllers/evaluation/evaluate';
import { TsToOpenApiError } from '#controllers/diagnostics';

interface Project {
  readonly root: string;
}

function project(t: TestContext): Project {
  const root = createFixtureProject(t, 'golem-route-eval-');
  writeGeneratedArtifacts([
    {
      path: path.join(root, 'package.json'),
      content: `${JSON.stringify({
        name: 'route-eval-fixture',
        type: 'module',
        imports: { '#paths': './src/lib/paths.js' },
      }, null, 2)}\n`,
    },
    {
      path: path.join(root, 'tsconfig.base.json'),
      content: `${JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
        },
      }, null, 2)}\n`,
    },
    {
      path: path.join(root, 'tsconfig.json'),
      content: `${JSON.stringify({ extends: './tsconfig.base.json', include: ['src/**/*.ts'] }, null, 2)}\n`,
    },
  ]);
  return { root };
}

function write(root: string, relative: string, content: string): string {
  const filename = path.join(root, relative);
  writeGeneratedArtifacts([{ path: filename, content }]);
  return filename;
}

function compile(root: string): ts.Program {
  return ts.createProgramFromSources({ root, sources: [] });
}

function routeExpression(program: ts.Program, filename: string): ts.Expression {
  const sourceFile = program.getSourceFile(filename);
  if (!sourceFile) throw new Error(`Missing source: ${filename}`);
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'ROUTE' && node.initializer) {
      found = node.initializer;
      return;
    }
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression) && node.expression.arguments.length > 0) {
      const callee = node.expression.expression.getText(sourceFile);
      if (callee === 'Get' || callee.endsWith('.Get')) {
        found = node.expression.arguments[0];
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`No route expression in ${filename}`);
  return found;
}

function expressionsByName(program: ts.Program, filename: string): Map<string, ts.Expression> {
  const sourceFile = program.getSourceFile(filename);
  if (!sourceFile) throw new Error(`Missing source: ${filename}`);
  const byName = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        byName.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return byName;
}

function portablePath(filename: string): string {
  return filename.split(path.sep).join('/');
}

test('literal and computed results honor maxResultBytes', async (t: TestContext) => {
  const { root } = project(t);
  const filename = write(root, 'src/size.ts', [
    "export const ROUTE = 'abcdefghij';",
    "export const ROUTES = ['/a', '/b'];",
    '',
  ].join('\n'));
  const program = compile(root);
  const byName = expressionsByName(program, filename);
  await assert.rejects(
    () => evaluateRouteExpression(byName.get('ROUTE')!, program, { maxResultBytes: 8 }),
    /RUNT2106/,
  );
  assert.equal(await evaluateRouteExpression(byName.get('ROUTE')!, program, { maxResultBytes: 20 }), 'abcdefghij');
  assert.deepEqual(await evaluateRouteExpression(byName.get('ROUTES')!, program), ['/a', '/b']);
  assert.deepEqual(await evaluateRouteExpression(byName.get('ROUTES')!, program, { maxResultBytes: 20 }), ['/a', '/b']);
});

test('rejects invalid evaluation options', async (t: TestContext) => {
  const { root } = project(t);
  const filename = write(root, 'src/options.ts', "export const ROUTE = '/ok';\n");
  const program = compile(root);
  const expression = routeExpression(program, filename);
  await assert.rejects(() => evaluateRouteExpression(expression, program, { maxResultBytes: 0 }), /maxResultBytes/);
  await assert.rejects(() => evaluateRouteExpression(expression, program, { maxResultBytes: -1 }), /maxResultBytes/);
  await assert.rejects(() => evaluateRouteExpression(expression, program, { maxResultBytes: 1.5 }), /maxResultBytes/);
});

test('resolves imported helpers, aliases, barrels, objects, and static methods', async (t: TestContext) => {
  const { root } = project(t);
  const fixtures = 'controllers/evaluation/resolves-imported-helpers-aliases-barrels-objects-and-static-methods';
  write(root, 'src/paths.ts', readFixture(`${fixtures}/paths.ts`));
  write(root, 'src/alias.ts', readFixture(`${fixtures}/alias.ts`));
  write(root, 'src/barrel.ts', readFixture(`${fixtures}/barrel.ts`));
  write(root, 'src/helpers.ts', readFixture("controllers/evaluation/resolves-imported-helpers-aliases-barrels-objects-and-static-methods/helpers.ts"));
  const filename = write(root, 'src/controller.ts', readFixture("controllers/evaluation/resolves-imported-helpers-aliases-barrels-objects-and-static-methods/controller.ts"));
  const program = compile(root);
  const byName = expressionsByName(program, filename);
  const watched: string[] = [];
  const onInput = (filename: string): void => { watched.push(filename); };
  assert.equal(await evaluateRouteExpression(byName.get('ROUTE')!, program, { onInput }), '/etcc/dsdc');
  assert.equal(watched.some((filename) => portablePath(filename).endsWith('/barrel.ts')), true);
  assert.equal(await evaluateRouteExpression(byName.get('OBJECT')!, program, { onInput }), '/api/items/7');
  assert.equal(await evaluateRouteExpression(byName.get('STATIC')!, program, { onInput }), '/urls/all');
  assert.equal(watched.some((filename) => portablePath(filename).endsWith('/helpers.ts')), true);
});

test('watch inputs include the controller and a package-import-resolved helper despite an extended tsconfig', async (t: TestContext) => {
  const { root } = project(t);
  const packageImportFixtures = 'controllers/evaluation/resolves-imported-helpers-aliases-barrels-and-package-imports';
  write(root, 'src/lib/package.json', readFixture(`${packageImportFixtures}/watch-package.json`));
  write(root, 'src/lib/paths.ts', readFixture(`${packageImportFixtures}/paths.ts`));
  const filename = write(root, 'src/controller.ts', readFixture(`${packageImportFixtures}/controller.ts`));
  const program = compile(root);
  const watched: string[] = [];
  assert.equal(await evaluateRouteExpression(routeExpression(program, filename), program, { onInput: (filename) => { watched.push(filename); } }), '/root');
  const portable = watched.map(portablePath);
  assert.equal(portable.some((filename) => filename.endsWith('/paths.ts')), true);
  assert.equal(portable.some((filename) => filename.endsWith('/controller.ts')), true);
});

test('does not import a controller module with bootstrap side effects', async (t: TestContext) => {
  const { root } = project(t);
  const filename = write(root, 'src/tasks.controller.ts', readFixture("controllers/evaluation/does-not-import-a-controller-module-with-bootstrap-side-effects/tasks.controller.ts"));
  const program = compile(root);
  const expression = routeExpression(program, filename);
  assert.equal(await evaluateRouteExpression(expression, program), '/tasks');
});

test('does not execute unused helpers or module-level throws in imported files', async (t: TestContext) => {
  const { root } = project(t);
  const fixtures = 'controllers/evaluation/does-not-execute-unused-helpers-or-module-level-throws';
  write(root, 'src/noisy.ts', readFixture(`${fixtures}/noisy.ts`));
  const filename = write(root, 'src/controller.ts', readFixture(`${fixtures}/controller.ts`));
  const program = compile(root);
  const expression = routeExpression(program, filename);
  assert.equal(await evaluateRouteExpression(expression, program), '/root');
});

test('rejects expressions that are not literals or simple helpers', async (t: TestContext) => {
  const { root } = project(t);
  write(root, 'src/async.ts', 'export const ROUTE = Promise.resolve("/x");\n');
  write(root, 'src/number.ts', 'export const ROUTE = 12;\n');
  write(root, 'src/env.ts', 'export const ROUTE = process.env.HOME ?? "/x";\n');
  write(root, 'src/join.ts', 'export const ROUTE = ["aa", "bb"].join("/");\n');
  write(root, 'src/hang.ts', readFixture("controllers/evaluation/rejects-expressions-that-are-not-literals-or-simple-helpers/hang.ts"));
  const program = compile(root);
  const evaluateFile = async (relative: string): Promise<unknown> => (
    evaluateRouteExpression(routeExpression(program, path.join(root, relative)), program)
  );
  await assert.rejects(() => evaluateFile('src/async.ts'), /string literal or a simple route helper/);
  await assert.rejects(() => evaluateFile('src/number.ts'), /string literal or a simple route helper/);
  await assert.rejects(() => evaluateFile('src/env.ts'), /string literal or a simple route helper/);
  await assert.rejects(() => evaluateFile('src/join.ts'), /string literal or a simple route helper/);
  await assert.rejects(() => evaluateFile('src/hang.ts'), /string literal or a simple route helper/);
});

test('folds string concatenation, const prefixes, and destructured object parameters', async (t: TestContext) => {
  const { root } = project(t);
  write(root, 'src/routes.ts', readFixture("controllers/evaluation/folds-string-concatenation-const-prefixes-and-destructured-object-parameters/routes.ts"));
  const filename = write(root, 'src/controller.ts', readFixture("controllers/evaluation/folds-string-concatenation-const-prefixes-and-destructured-object-parameters/controller.ts"));
  const program = compile(root);
  const byName = expressionsByName(program, filename);
  assert.equal(await evaluateRouteExpression(byName.get('JOINED')!, program), 'items/list');
  assert.equal(await evaluateRouteExpression(byName.get('RESOURCE')!, program), 'payments/transactions');
});

test('rejects let and var route constants with a typed diagnostic', async (t: TestContext) => {
  const { root } = project(t);
  const letFile = write(root, 'src/let.ts', "let prefix = '/tasks';\nprefix = '/other';\nexport const ROUTE = prefix;\n");
  const varFile = write(root, 'src/var.ts', "var prefix = '/tasks';\nexport const ROUTE = `${prefix}/list`;\n");
  const program = compile(root);
  for (const filename of [letFile, varFile]) {
    await assert.rejects(
      () => evaluateRouteExpression(routeExpression(program, filename), program),
      (error: unknown) => error instanceof TsToOpenApiError
        && error.diagnostics.some(item => String(item.code) === 'RUNT2101' && item.file?.endsWith(path.basename(filename)) === true),
    );
  }
});

test('folds the same helper called more than once in one expression', async (t: TestContext) => {
  const { root } = project(t);
  const filename = write(root, 'src/repeat.ts', [
    "function base(): string { return 'api'; }",
    "function scoped(name: string): string { return `${base()}/${name}`; }",
    'export const ROUTE = `${base()}/${base()}/${scoped(\'v1\')}/${scoped(\'v1\')}`;',
    '',
  ].join('\n'));
  const program = compile(root);
  assert.equal(await evaluateRouteExpression(routeExpression(program, filename), program), 'api/api/api/v1/api/v1');
});

test('rejects a helper that recurses with growing arguments instead of overflowing the stack', async (t: TestContext) => {
  const { root } = project(t);
  const filename = write(root, 'src/grow.ts', [
    "function p(x: string): string { return p(x + '/'); }",
    "export const ROUTE = p('a');",
    '',
  ].join('\n'));
  const program = compile(root);
  await assert.rejects(
    () => evaluateRouteExpression(routeExpression(program, filename), program),
    (error: unknown) => error instanceof TsToOpenApiError && error.diagnostics.some(item => String(item.code) === 'RUNT2101'),
  );
});

test('folds helper chains up to the nesting cap and rejects deeper chains', async (t: TestContext) => {
  const { root } = project(t);
  // h0 calls h1 ... calls h<depth-1>, which returns a literal: `depth` nested helper calls.
  const chain = (depth: number, prefix: string): string => Array.from({ length: depth }, (_, index) => (
    index === depth - 1
      ? `function ${prefix}${index}(): string { return 'end'; }`
      : `function ${prefix}${index}(): string { return ${prefix}${index + 1}(); }`
  )).join('\n');
  const within = write(root, 'src/within.ts', `${chain(64, 'a')}\nexport const ROUTE = a0();\n`);
  const beyond = write(root, 'src/beyond.ts', `${chain(65, 'b')}\nexport const ROUTE = b0();\n`);
  const program = compile(root);
  assert.equal(await evaluateRouteExpression(routeExpression(program, within), program), 'end');
  await assert.rejects(
    () => evaluateRouteExpression(routeExpression(program, beyond), program),
    (error: unknown) => error instanceof TsToOpenApiError && error.diagnostics.some(item => String(item.code) === 'RUNT2101'),
  );
});

test('folds an enum member and a const object member used as a route path', async (t: TestContext) => {
  // protects: F-163 a controller or route path from an enum or const object member, as Nest reads it (T-178)
  const { root } = project(t);
  const filename = write(root, 'src/members.ts', [
    "enum Routes { Users = 'users' }",
    "const PATHS = { users: 'people', nested: { admin: 'admin' } } as const;",
    'export const ENUM = Routes.Users;',
    'export const OBJECT = PATHS.nested.admin;',
    "export const QUOTED = PATHS['users'];",
    'export const JOINED = `${Routes.Users}/${PATHS.users}`;',
    'export const MISSING = PATHS.missing;',
    '',
  ].join('\n'));
  const program = compile(root);
  const byName = expressionsByName(program, filename);
  const fold = (name: string): Promise<unknown> => evaluateRouteExpression(byName.get(name)!, program);
  assert.equal(await fold('ENUM'), 'users');
  assert.equal(await fold('OBJECT'), 'admin');
  assert.equal(await fold('QUOTED'), 'people');
  assert.equal(await fold('JOINED'), 'users/people');
  await assert.rejects(() => fold('MISSING'), (error: unknown) => (
    error instanceof TsToOpenApiError && error.diagnostics.some(item => String(item.code) === 'RUNT2101')
  ));
});
