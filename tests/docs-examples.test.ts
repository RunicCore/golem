import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { docExampleSources } from '../scripts/docs-examples.js';

function docsRoot(t: TestContext, files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'golem-docs-examples-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  }
  return root;
}

const task = [
  '// #region task-model',
  'export class Task {}',
  '// #endregion task-model',
  '',
].join('\n');
const config = [
  '# region openapi-job',
  'jobs: []',
  '# endregion openapi-job',
  '',
].join('\n');

test('every included region that the file declares resolves', t => {
  const root = docsRoot(t, {
    'examples/app/src/task.ts': task,
    'examples/app/golem.yaml': config,
    'docs/guide/models.md': '# Models\n\n<<< @/../examples/app/src/task.ts#task-model{ts}\n<<< ../../examples/app/golem.yaml#openapi-job\n',
  });
  assert.deepEqual(docExampleSources(root), [
    { source: 'examples/app/golem.yaml' },
    { source: 'examples/app/src/task.ts' },
  ]);
});

test('an included whole file needs no region', t => {
  const root = docsRoot(t, {
    'examples/app/src/task.ts': 'export class Task {}\n',
    'docs/guide/models.md': '<<< @/../examples/app/src/task.ts\n',
  });
  assert.deepEqual(docExampleSources(root), [{ source: 'examples/app/src/task.ts' }]);
});

test('a missing region fails and names the page, the file and the region', t => {
  const root = docsRoot(t, {
    'examples/app/src/task.ts': task,
    'docs/guide/models.md': '<<< @/../examples/app/src/task.ts#task-renamed\n',
  });
  assert.throws(
    () => docExampleSources(root),
    new Error('Documentation region is missing: docs/guide/models.md -> examples/app/src/task.ts#task-renamed'),
  );
});

test('a region that is opened and never closed counts as missing', t => {
  const root = docsRoot(t, {
    'examples/app/src/task.ts': '// #region task-model\nexport class Task {}\n',
    'docs/guide/models.md': '<<< @/../examples/app/src/task.ts#task-model\n',
  });
  assert.throws(() => docExampleSources(root), /Documentation region is missing: .*#task-model/);
});

test('a region closed with a different marker form counts as missing', t => {
  const root = docsRoot(t, {
    'examples/app/src/task.ts': '// #region task-model\nexport class Task {}\n/* #endregion task-model */\n',
    'docs/guide/models.md': '<<< @/../examples/app/src/task.ts#task-model\n',
  });
  assert.throws(() => docExampleSources(root), /Documentation region is missing: .*#task-model/);
});
