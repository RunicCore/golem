import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '@exprtlabs/golem-model/generator';
import { environment, gitState } from './results.js';

// Times the model job on synthetic projects. Run after `npm run build && npm run build:scripts`:
//   node .build/scripts/benchmark/generation.js
// Each case runs in its own process, so its first run pays the cold start and maxRss is its own.
// Run nothing else meanwhile: concurrent compiles change the timings severalfold.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const profile = { mobx: false, validation: true, ajvStandalone: false };

interface GenerationCase {
  readonly id: string;
  readonly description: string;
  readonly ajvStandalone: boolean;
  readonly sources: (count: number) => Record<string, string>;
  readonly count: number;
}

/** Independent models: one IModel per file, no references. */
function independentSources(count: number): Record<string, string> {
  const sources: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    sources[`item-${index}.model.ts`] = `import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { TItem${index}BaseModel } from './item-${index}.model.generated.js';
export type TItem${index} = IModel<{ label: string & MinLength<3>; count: number }>;
export class Item${index} extends TItem${index}BaseModel {}
`;
  }
  return sources;
}

/** Item i references item i-1 twice; the CHANGELOG's "80 chained models" figure uses this shape. */
function chainSources(count: number): Record<string, string> {
  const sources: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    const previous = index > 0 ? `import type { TItem${index - 1} } from './item-${index - 1}.model.js';\n` : '';
    const fields = index > 0 ? `; prev: TItem${index - 1}; prevs?: TItem${index - 1}[]` : '';
    sources[`item-${index}.model.ts`] = `import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
${previous}import { TItem${index}BaseModel } from './item-${index}.model.generated.js';
export type TItem${index} = IModel<{ label: string & MinLength<3>; at: Date; kind: { k: 'a'; a: Date } | { k: 'b'; b: number }${fields} }>;
export class Item${index} extends TItem${index}BaseModel {}
`;
  }
  return sources;
}

export const GENERATION_CASES: readonly GenerationCase[] = [
  { id: 'independent-10', description: '10 independent models', ajvStandalone: false, sources: independentSources, count: 10 },
  { id: 'independent-100', description: '100 independent models', ajvStandalone: false, sources: independentSources, count: 100 },
  { id: 'independent-100-standalone', description: '100 independent models, precompiled Ajv', ajvStandalone: true, sources: independentSources, count: 100 },
  { id: 'chain-80', description: '80 models, each referencing the previous one twice', ajvStandalone: false, sources: chainSources, count: 80 },
];

const RUNS = 2;

interface CaseResult {
  readonly id: string;
  readonly description: string;
  readonly runsMs: number[];
  readonly artifacts: number;
  readonly outputBytes: number;
  readonly maxRssMb: number;
}

function createProject(directory: string, sources: Record<string, string>): string {
  const project = mkdtempSync(path.join(directory, 'case-'));
  mkdirSync(path.join(project, 'src'));
  symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, rootDir: 'src', outDir: 'build' },
    include: ['src/**/*.ts'],
  }));
  for (const [name, content] of Object.entries(sources)) writeFileSync(path.join(project, 'src', name), content);
  return project;
}

function measureCase(spec: GenerationCase, directory: string): CaseResult {
  const runsMs: number[] = [];
  let artifacts = 0;
  let outputBytes = 0;
  for (let run = 0; run < RUNS; run++) {
    // A fresh project per run: the job's session must not reuse the previous run's analysis.
    const project = createProject(directory, spec.sources(spec.count));
    (globalThis as { gc?: () => void }).gc?.();
    const started = performance.now();
    const result = generate({ root: project, profile: { ...profile, ajvStandalone: spec.ajvStandalone } });
    runsMs.push(Math.round(performance.now() - started));
    artifacts = result.artifacts.length;
    outputBytes = result.artifacts.reduce((sum, artifact) => sum + Buffer.byteLength(artifact.content), 0);
  }
  return { id: spec.id, description: spec.description, runsMs, artifacts, outputBytes, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) };
}

function runChild(id: string, directory: string): CaseResult {
  const stdout = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--case', id, '--directory', directory],
    { cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout) as CaseResult;
}

export function main(argv: readonly string[]): void {
  const caseIndex = argv.indexOf('--case');
  if (caseIndex >= 0) {
    const spec = GENERATION_CASES.find(candidate => candidate.id === argv[caseIndex + 1]);
    if (!spec) throw new Error(`unknown case ${argv[caseIndex + 1]}`);
    process.stdout.write(JSON.stringify(measureCase(spec, argv[argv.indexOf('--directory') + 1]!)));
    return;
  }
  mkdirSync(path.join(root, '.cache/benchmark'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/generation-work-'));
  try {
    const git = gitState(root);
    const cases = GENERATION_CASES.map(spec => runChild(spec.id, directory));
    const output = path.join(root, '.cache/benchmark/generation.json');
    writeFileSync(output, JSON.stringify({ measuredAt: new Date().toISOString(), git, environment: environment(), profile, runs: RUNS, cases }, null, 2) + '\n');
    const lines = [`${'case'.padEnd(28)} ${'runs ms'.padStart(14)} ${'files'.padStart(6)} ${'output'.padStart(10)} ${'max RSS'.padStart(9)}`];
    for (const c of cases) {
      lines.push(`${c.id.padEnd(28)} ${c.runsMs.join(' / ').padStart(14)} ${String(c.artifacts).padStart(6)} ${`${(c.outputBytes / 1024 / 1024).toFixed(2)} MB`.padStart(10)} ${`${c.maxRssMb} MB`.padStart(9)}`);
    }
    process.stdout.write(`${lines.join('\n')}\n\nWrote ${path.relative(root, output)} (git ${git.sha.slice(0, 7)}${git.dirty ? ', dirty' : ''})\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
