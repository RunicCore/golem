import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { BENCH_ADAPTERS } from './cases.js';
import { ADAPTERS, type Adapter, type ComparisonFixture, type ComparisonModule } from './fixture-contract.js';
import type { BatchSample } from './results.js';
import { sampleAsync, sampleSync, schedule } from './sampling.js';
import { parseWorkerJob, type WorkerCaseResult, type WorkerJob, type WorkerOutput } from './worker-protocol.js';

const [modulePath, fixtureAdapter, jobText] = process.argv.slice(2);
if (!modulePath || !fixtureAdapter || !jobText) throw new Error('Usage: worker.js <casesModule> <fixtureAdapter> <jobJson>');
const job = parseWorkerJob(jobText);
const isAdapter = (value: string): value is Adapter => (ADAPTERS as readonly string[]).includes(value);
if (!isAdapter(fixtureAdapter)) throw new Error(`Unknown fixture adapter: ${fixtureAdapter}`);
// The 'plain' group parses to plain objects (an IObject declaration, or a peer library's plain-object mode), and so
// does an adapter marked `plainObjects`; other groups produce class instances, so this check applies only there.
const adapterSpec = BENCH_ADAPTERS.find(a => a.fixtureAdapter === fixtureAdapter);
const parsesToPlainObject = adapterSpec?.group === 'plain' || adapterSpec?.plainObjects === true;
const suite: ComparisonModule = await import(pathToFileURL(modulePath).href);
const wanted = new Set(job.cases.map(c => c.fixture));
const fixtures = (await suite.createComparisonFixtures(fixtureAdapter)).filter(f => wanted.has(f.name));

let checksum = 0;
interface Runnable { readonly fixture: ComparisonFixture; readonly key: string; readonly operation: WorkerJob['cases'][number]['operation']; readonly run: () => unknown }
const runnables: Runnable[] = job.cases.map(c => {
  const fixture = fixtures.find(f => f.name === c.fixture);
  if (!fixture) throw new Error(`${fixtureAdapter}: fixture ${c.fixture} not provided`);
  const run = fixture.operations[c.operation];
  if (!run) throw new Error(`${fixtureAdapter}: ${c.fixture} has no ${c.operation}`);
  return { fixture, key: `${c.fixture}/${c.operation}`, operation: c.operation, run };
});

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value;
const call = async (item: Runnable): Promise<unknown> => { const value = item.run(); return isThenable(value) ? await value : value; };

// Correctness: library checks run in their own verify process; a measuring process checks each call's result on valid input only.
if (job.mode === 'verify') for (const fixture of fixtures) await fixture.verify();
const originals = new Map(fixtures.map(f => [f.name, structuredClone(f.payload)]));
async function verifyCalls(): Promise<void> {
  for (const item of runnables) {
    const value = await call(item);
    const consumed = item.fixture.consume(value);
    assert.ok(Number.isFinite(consumed) && consumed > 0, `Unconsumed result: ${fixtureAdapter}/${item.key}`);
    if (item.operation === 'validate') assert.equal(value, true, `Validate rejected a valid fixture: ${fixtureAdapter}/${item.key}`);
    if (item.operation === 'text-to-model' && parsesToPlainObject) {
      assert.equal(Object.getPrototypeOf(value), Object.prototype, `Parse did not return a plain object: ${fixtureAdapter}/${item.key}`);
    }
    if (item.operation === 'model-to-text') {
      assert.equal(typeof value, 'string');
      assert.deepEqual(JSON.parse(value as string), originals.get(item.fixture.name), `Output drift: ${fixtureAdapter}/${item.key}`);
    }
  }
  for (const fixture of fixtures) assert.deepEqual(fixture.payload, originals.get(fixture.name), `Payload mutated: ${fixtureAdapter}/${fixture.name}`);
}
await verifyCalls();
if (job.mode === 'verify') {
  const verified: WorkerOutput = { fixtureAdapter, checksum: 1, cases: runnables.map(r => ({ fixture: r.fixture.name, operation: r.operation, payloadBytes: Buffer.byteLength(JSON.stringify(r.fixture.payload)), samples: [] })) };
  process.stdout.write(JSON.stringify(verified));
  process.exit(0);
}

// Synchronous calls are timed without a per-call await; only calls that return a thenable use the async loop.
const asynchronous = new Map<string, boolean>();
for (const item of runnables) {
  const probe = item.run();
  asynchronous.set(item.key, isThenable(probe));
  if (isThenable(probe)) await probe;
}

const samples = new Map<string, BatchSample[]>(runnables.map(r => [r.key, []]));
for (const step of schedule(runnables.length, job.settings)) {
  const item = runnables[step.index];
  const consume = (value: unknown) => item.fixture.consume(value);
  const result = asynchronous.get(item.key) ? await sampleAsync(item.run, consume, step.durationMs) : sampleSync(item.run, consume, step.durationMs);
  checksum = (checksum + result.checksum) % 2_147_483_647;
  if (step.timed) samples.get(item.key)?.push({ iterations: result.iterations, elapsedMs: result.elapsedMs });
}
await verifyCalls();
assert.ok(Number.isFinite(checksum) && checksum > 0, 'Benchmark results were not consumed');

const cases: WorkerCaseResult[] = runnables.map(r => ({
  fixture: r.fixture.name, operation: r.operation,
  payloadBytes: Buffer.byteLength(JSON.stringify(r.fixture.payload)),
  samples: samples.get(r.key) ?? [],
}));
const output: WorkerOutput = { fixtureAdapter, checksum, cases };
process.stdout.write(JSON.stringify(output));
