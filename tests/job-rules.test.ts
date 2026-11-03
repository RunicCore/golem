import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { JobFacts, JobOutput, ProgramView } from '#golem/job-facts';
import { JobRuleError, resolveJobPlan } from '#golem/job-rules';

/** A path as the messages print it: relative to the working directory. */
const shown = (filename: string): string => path.relative(process.cwd(), filename);

const context = { configFile: '/app/golem.yaml', tsconfigDirectory: '/app' };
const documentFile = '/app/api/payments.yaml';

function job(id: string, facts: Partial<Omit<JobFacts, 'id'>> = {}): JobFacts {
  return { id, outputs: [], ownedRoots: [], inputFiles: [], inputFolders: [], readsProgram: false, provides: [], needs: [], hooks: [], watch: [], ...facts };
}

function file(filename: string): JobOutput {
  return { path: filename, kind: 'file' };
}

function folder(directory: string): JobOutput {
  return { path: directory, kind: 'folder' };
}

/** The doc job: reads the program, writes the document, needs the models boundary. */
function docs(): JobFacts {
  return job('docs', { readsProgram: true, ownedRoots: ['/app'], outputs: [file(documentFile)], needs: ['ModelBoundary'] });
}

/** An SDK job: reads the document; a golem SDK needs the codec host. */
function sdk(output: string, golemMode: boolean): JobFacts {
  return job('sdk', { inputFiles: [documentFile], outputs: [folder(output)], needs: golemMode ? ['CodecsHost'] : [] });
}

/** The models job: reads the program and the folders of golem SDKs, provides both contracts. */
function models(sdkFolders: readonly string[]): JobFacts {
  return job('models', {
    readsProgram: true,
    ownedRoots: ['/app'],
    inputFolders: sdkFolders,
    outputs: [{ path: '/app/src/generated/models', kind: 'folder', importedByApp: true }],
    provides: ['ModelBoundary', 'CodecsHost'],
    hooks: ['model.validatorEnhancer', 'model.codecData'],
  });
}

function generator(output: string, facts: Partial<Omit<JobFacts, 'id'>> = {}): JobFacts {
  return job('gen', { outputs: [folder(output)], ...facts });
}

function order(jobs: readonly JobFacts[]): readonly string[] {
  return resolveJobPlan(jobs, context).order;
}

function rejection(rule: JobRuleError['rule'], jobs: readonly string[], message: string) {
  return { name: 'JobRuleError', rule, jobs, message };
}

test('rule 1: a job runs after the job whose output file or folder it reads, wherever config lists it', () => {
  // protects: page rule 1, the order from file edges
  assert.deepEqual(order([sdk('/app/sdk', true), models(['/app/sdk']), docs()]), ['docs', 'sdk', 'models']);
});

test('rule 1: a cycle of reads stops loading and names the jobs', () => {
  // protects: page failure row, a cycle of reads
  const jobs = [
    job('docs', { outputs: [file('/app/a.yaml')], inputFolders: ['/app/gen'] }),
    job('sdk', { inputFiles: ['/app/a.yaml'], outputs: [folder('/app/sdk')] }),
    job('gen', { inputFolders: ['/app/sdk'], outputs: [folder('/app/gen')] }),
  ];
  assert.throws(
    () => resolveJobPlan(jobs, context),
    rejection('cycle', ['docs', 'sdk', 'gen'], "Jobs read each other's output in a cycle: docs writes what sdk reads, sdk writes what gen reads, gen writes what docs reads."),
  );
});

test('rule 2: a job that reads no program runs before every program reader, wherever config lists it', () => {
  // protects: page rule 2, generators before program readers
  assert.deepEqual(order([docs(), models([]), generator('/elsewhere/gen')]), ['gen', 'docs', 'models']);
});

test('rule 2: an edge that a path decides is added before config order breaks a tie', () => {
  // protects: rule 2 cycled in page review rounds 1 to 3 (ties broken before the paths were closed)
  const second = job('second', { readsProgram: true });
  const first = job('first', { readsProgram: true, outputs: [file('/app/first.out')] });
  const between = job('between', { inputFiles: ['/app/first.out'] });
  assert.deepEqual(order([second, first, between]), ['first', 'between', 'second']);
});

test('rule 2: a tie edge never contradicts a path', () => {
  // protects: rule 2 cycled in page review rounds 1 to 3 (all ties added at once made a cycle)
  const a = job('a', { readsProgram: true, inputFiles: ['/app/c.out'] });
  const b = job('b', { readsProgram: true });
  const c = job('c', { readsProgram: true, outputs: [file('/app/c.out')] });
  assert.deepEqual(order([a, b, c]), ['c', 'a', 'b']);
});

test('rule 2: two program readers that do not read each other run in config order', () => {
  // protects: page rule 2, the config-order tie
  const x = job('x', { readsProgram: true });
  const y = job('y', { readsProgram: true });
  assert.deepEqual(order([x, y]), ['x', 'y']);
  assert.deepEqual(order([y, x]), ['y', 'x']);
});

const layouts: readonly { name: string; jobs: readonly JobFacts[]; order: readonly string[]; views: Readonly<Record<string, ProgramView>> }[] = [
  {
    name: 'a standalone SDK outside the tsconfig folder',
    jobs: [docs(), sdk('/sibling/sdk', false), models([])],
    order: ['docs', 'sdk', 'models'],
    views: {
      docs: { laterOutputs: ['/sibling/sdk'] },
      models: { laterOutputs: [] },
    },
  },
  {
    name: 'a generator outside the app',
    jobs: [docs(), models([]), generator('/elsewhere/gen')],
    order: ['gen', 'docs', 'models'],
    views: {
      docs: { laterOutputs: [] },
      models: { laterOutputs: [] },
    },
  },
  {
    name: 'a generator listed after the doc block',
    jobs: [docs(), generator('/app/src/generated/acme'), models([])],
    order: ['gen', 'docs', 'models'],
    views: {
      docs: { laterOutputs: [] },
      models: { laterOutputs: [] },
    },
  },
  {
    name: 'a generator that the models job reads',
    jobs: [models(['/app/src/generated/acme']), docs(), generator('/app/src/generated/acme')],
    order: ['gen', 'models', 'docs'],
    views: {
      models: { laterOutputs: [documentFile] },
      docs: { laterOutputs: [] },
    },
  },
  {
    name: 'a generator that reads the document',
    jobs: [docs(), models([]), generator('/app/src/generated/acme', { inputFiles: [documentFile] })],
    order: ['docs', 'gen', 'models'],
    views: {
      docs: { laterOutputs: ['/app/src/generated/acme'] },
      models: { laterOutputs: [] },
    },
  },
  {
    name: 'no doc job',
    jobs: [models(['/app/sdk']), sdk('/app/sdk', true)],
    order: ['sdk', 'models'],
    views: { models: { laterOutputs: [] } },
  },
  {
    name: 'a controller that imports a companion, doc block first',
    jobs: [docs(), models([])],
    order: ['docs', 'models'],
    views: {
      docs: { laterOutputs: [] },
      models: { laterOutputs: [] },
    },
  },
  {
    name: 'a controller that imports a companion, models block first',
    jobs: [models([]), docs()],
    order: ['models', 'docs'],
    views: {
      models: { laterOutputs: [documentFile] },
      docs: { laterOutputs: [] },
    },
  },
  {
    name: 'a golem SDK inside the app, between the doc job and the models job',
    jobs: [models(['/app/sdk']), sdk('/app/sdk', true), docs()],
    order: ['docs', 'sdk', 'models'],
    views: {
      docs: { laterOutputs: ['/app/sdk'] },
      models: { laterOutputs: [] },
    },
  },
];

for (const layout of layouts) {
  test(`layout: ${layout.name}`, () => {
    // protects: page review rounds 1 to 4, the seven reviewed layouts (and a golem SDK in the app, the round 1 cycle)
    const plan = resolveJobPlan(layout.jobs, context);
    assert.deepEqual(plan.order, layout.order);
    assert.deepEqual(plan.programViews, layout.views);
  });
}

test('contracts: each contract names its one provider', () => {
  // protects: page contracts rule, one provider per contract
  assert.deepEqual(resolveJobPlan([docs(), models([])], context).providers, { ModelBoundary: 'models', CodecsHost: 'models' });
});

test('contracts: a needed contract with no provider stops loading and names it', () => {
  // protects: page failure row, a needed contract has no provider
  assert.throws(
    () => resolveJobPlan([docs()], context),
    rejection('contract-missing', ['docs'], 'Job docs needs the contract ModelBoundary, but no job provides it.'),
  );
});

test('contracts: two providers of one contract stop loading and name both', () => {
  // protects: page failure row, two packages provide one contract
  const other = { ...models([]), id: 'models-2', outputs: [folder('/app/other')] };
  assert.throws(
    () => resolveJobPlan([models([]), other], context),
    rejection('contract-twice', ['models', 'models-2'], 'The contract ModelBoundary has two providers, models and models-2. At most one job provides it.'),
  );
});

test('contracts: ModelBoundary is optional when no job needs it', () => {
  // protects: page contracts rule, the rewrite serves SDK models only without a provider
  const plan = resolveJobPlan([sdk('/sibling/sdk', false)], context);
  assert.deepEqual(plan.providers, {});
  assert.deepEqual(plan.order, ['sdk']);
});

test('overlap: exclusive outputs that equal or hold each other stop loading and name both jobs', () => {
  // protects: page overlap rule
  const message = `Overlapping outputs: ${shown('/app/sdk')} (job sdk) and ${shown('/app/sdk/api.yaml')} (job docs).`;
  assert.throws(
    () => resolveJobPlan([sdk('/app/sdk', false), job('docs', { outputs: [file('/app/sdk/api.yaml')] })], context),
    rejection('overlap', ['sdk', 'docs'], message),
  );
  assert.throws(
    () => resolveJobPlan([sdk('/app/sdk', false), generator('/app/sdk')], context),
    rejection('overlap', ['sdk', 'gen'], `Overlapping outputs: ${shown('/app/sdk')} (job sdk) and ${shown('/app/sdk')} (job gen).`),
  );
});

test('overlap: folders whose names share a prefix do not overlap, and an SDK inside an owned root is allowed', () => {
  // protects: page overlap rule, owned roots are not outputs
  const plan = resolveJobPlan([sdk('/app/sdk', false), generator('/app/sdk-gen'), models([])], context);
  assert.deepEqual(plan.order, ['sdk', 'gen', 'models']);
});

test('reserved outputs: no output holds golem.yaml or lies in the .golem folder', () => {
  // protects: page overlap rule, golem.yaml and .golem/ belong to core
  assert.throws(() => resolveJobPlan([job('docs', { outputs: [file('/app/golem.yaml')] })], context), rejection('reserved-output', ['docs'], `Job docs: output ${shown('/app/golem.yaml')} holds golem.yaml, which golem owns.`));
  assert.throws(() => resolveJobPlan([generator('/app/.golem/cache')], context), rejection('reserved-output', ['gen'], `Job gen: output ${shown('/app/.golem/cache')} overlaps the .golem folder, which golem owns.`));
  assert.throws(() => resolveJobPlan([generator('/app')], context), rejection('reserved-output', ['gen'], `Job gen: output ${shown('/app')} holds golem.yaml, which golem owns.`));
});

test('containment: a job root outside the tsconfig folder stops loading (F-42)', () => {
  // protects: F-42 one golem.yaml serves one tsconfig
  assert.throws(
    () => resolveJobPlan([job('models', { ownedRoots: ['/other/app'] })], context),
    rejection('containment', ['models'], `Job models: root ${shown('/other/app')} is outside ${shown('/app')}; use one golem.yaml per tsconfig.`),
  );
});

test('containment: an output the app imports lies inside the tsconfig folder, any other output may lie anywhere (F-42)', () => {
  // protects: F-42 and F-261, only the output the app program imports is contained
  const imported: JobFacts = job('models', { outputs: [{ path: '/other/models', kind: 'folder', importedByApp: true }] });
  assert.throws(
    () => resolveJobPlan([imported], context),
    rejection('containment', ['models'], `Job models: output ${shown('/other/models')} is outside the tsconfig directory ${shown('/app')}. Move it inside.`),
  );
  assert.deepEqual(order([generator('/other/gen')]), ['gen']);
});

test('contracts: a wanted contract with no provider is no error, and two providers of it still stop loading', () => {
  // protects: T-768 the doc job wants ModelBoundary: a docs-only project loads (the old optional `models` option)
  const wanting = job('docs', { wants: ['ModelBoundary'] });
  assert.deepEqual(resolveJobPlan([wanting], context).providers, {});
  const other = { ...models([]), id: 'models-2', outputs: [folder('/app/other')] };
  assert.throws(() => resolveJobPlan([wanting, models([]), other], context), rejection('contract-twice', ['models', 'models-2'], 'The contract ModelBoundary has two providers, models and models-2. At most one job provides it.'));
});

test('containment: a scan root outside the tsconfig folder stops loading (F-42)', () => {
  // protects: F-42 a read-only folder of the doc job lies inside the tsconfig folder like an owned root
  assert.throws(
    () => resolveJobPlan([job('docs', { scanRoots: ['/other/app'] })], context),
    rejection('containment', ['docs'], `Job docs: root ${shown('/other/app')} is outside ${shown('/app')}; use one golem.yaml per tsconfig.`),
  );
});

test('rule 1: a job whose input lies in its own output stops loading as a cycle naming the job', () => {
  // protects: master "Generated input dependency cycle": a job that reads its own document
  assert.throws(
    () => resolveJobPlan([job('docs', { outputs: [file(documentFile)], inputFiles: [documentFile] })], context),
    rejection('cycle', ['docs'], "Jobs read each other's output in a cycle: docs writes what docs reads."),
  );
});
