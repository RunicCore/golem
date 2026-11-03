import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProject } from './fixture-project.js';
import { canonicalFilename, companionFilename, createModelStubProgram, modelBoundary } from '@exprtlabs/golem/internal/type-analysis';

const MODEL = `// import type { IModel as Hidden } from 'x';
import type {
  IModel as Model,
} from '@exprtlabs/golem/model';
import type * as G from '@exprtlabs/golem/model';
/* export type InComment = Model<{ a: string }>; */
const sample = 'export type InString = Model<{}>;';
export type Multi = /* wrapped */ Model<
  { id: string }
>;
export type Spaced = G
  .IModel<{ a: 1 }>;
export type NotModel = Hidden<{}>;
export type Plain = string;
`;

test('the first analysis stubs the class models a file declares, by syntax', (t) => {
  // protects: T-291 a model name in a comment or string gives no stub; a declaration with a comment inside still does
  const root = createFixtureProject(t, 'golem-stub-names-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true }, include: ['*.ts'] }));
  const file = path.join(root, 'order.model.ts');
  fs.writeFileSync(file, MODEL);
  const app = path.join(root, 'app.ts');
  fs.writeFileSync(app, "import type { MultiBaseModel } from './order.model.generated.js';\nexport type Base = MultiBaseModel;\n");
  const boundary = modelBoundary(root, ['.model.ts', '.models.ts']);
  const info = createModelStubProgram([file, app], root, boundary, [file]);
  t.after(() => info.program[Symbol.dispose]());
  const stub = info.program.getSourceFile(canonicalFilename(companionFilename(boundary, file)))?.text ?? '';
  assert.deepEqual([...stub.matchAll(/class (\w+)BaseModel/g)].map((match) => match[1]), ['Multi', 'Spaced']);
});
