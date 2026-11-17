import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { runBuild } from '#golem/build';
import { codecKeysPath } from '#golem/generated-paths';
import { applyRewrites } from '#golem/rewrite';
import { scanProject } from '#golem/rewrite-scan';
import { typescriptVersion } from '#golem/typescript-ns';
import type { GolemDiagnostic } from '#golem/generator-api';
import { NEST_PARTICIPANTS } from '../fixture-templates/controllers/project.js';
import { editProjectSources } from './node-specifiers-project.js';
import { BUILD_LOG, BUILT, caseFolder, DIAGNOSTICS, GENERATED, isBuilt, NON_MODEL_INPUTS, REWRITTEN, type IdentityProject } from './identity-corpus.js';
import { defaultModelOutput } from '@exprtlabs/golem-model/plan';

function describeDiagnostic(stage: string, diagnostic: GolemDiagnostic): string {
  return `${stage} ${diagnostic.code} ${diagnostic.file ?? '-'} ${diagnostic.line ?? '-'}:${diagnostic.column ?? '-'} ${diagnostic.message}`;
}

/**
 * A rejected project is an expected result here, not a fault of this process: the identity claim covers the message that each
 * version gives for it, so any error a stage throws becomes a line of the diagnostics file, where the test compares it.
 */
function describeError(stage: string, error: unknown): string {
  return `${stage} error: ${error instanceof Error ? error.message : String(error)}`;
}

/** The text the rewrite scan makes of each edited source file of the project, keyed by path relative to the root. */
function rewriteStage(item: IdentityProject, lines: string[]): ReadonlyMap<string, string> {
  const rewritten = new Map<string, string>();
  try {
    const scan = scanProject({
      root: item.root,
      boundary: { root: item.root, directory: item.root, output: defaultModelOutput(item.root), suffixes: ['.model.ts', '.models.ts'] },
      configFile: path.join(item.root, 'tsconfig.json'),
      // The NestJS side of the rewrite is what a controller case compares; extensions: nest in golem.yaml turns it on.
      participants: item.kind === 'controller' ? NEST_PARTICIPANTS[NON_MODEL_INPUTS] : [],
      codecKeysFile: path.join(item.root, '.golem/codec-keys.json'),
    });
    for (const diagnostic of scan.diagnostics) lines.push(describeDiagnostic('rewrite', diagnostic));
    for (const [relative, fileScan] of scan.files) {
      const filename = path.join(item.root, relative);
      rewritten.set(relative, applyRewrites(fs.readFileSync(filename, 'utf8'), fileScan, filename).code);
    }
  } catch (error) {
    lines.push(describeError('rewrite', error));
  }
  return rewritten;
}

/** The text the specifier edits make of each project source of the project that they change, keyed by path relative to the root. */
function specifierStage(item: IdentityProject, lines: string[]): ReadonlyMap<string, string> {
  try {
    return new Map([...editProjectSources(item.root)].filter(([, edited]) => edited.edits.length > 0).map(([relative, edited]) => [relative, edited.code]));
  } catch (error) {
    lines.push(describeError('rewrite', error));
    return new Map();
  }
}

/** The files of the project by path relative to the root, as bytes; the installed packages and golem's own state under `.golem` are no output of a build. */
function projectFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.golem') visit(filename);
      } else files.set(path.relative(root, filename), fs.readFileSync(filename));
    }
  };
  visit(root);
  return files;
}

/** The files a golem.yaml's jobs generated, by path relative to the root: those of the outputs record, and the codec keys that the models job writes beside it. */
function generatedFiles(root: string): ReadonlySet<string> {
  const record = path.join(root, '.golem/outputs.json');
  const recorded = fs.existsSync(record) ? Object.keys((JSON.parse(fs.readFileSync(record, 'utf8')) as { readonly files: Readonly<Record<string, unknown>> }).files) : [];
  const keys = codecKeysPath(root);
  return new Set([...recorded, ...(fs.existsSync(keys) ? [path.relative(root, keys)] : [])].map(file => path.relative(root, path.resolve(root, file))));
}

/**
 * `golem build` on the project, run in this process with the project as the working directory, and the one generation of its jobs: the
 * files they generated go under `generated/`, each other file the build wrote or changed in the project under `built/`, and the exit code
 * and what the build printed to the build log. A build that throws, as one does for a project that its jobs or the rewrite scan reject, gives a
 * line of the diagnostics. Returns whether the jobs generated any file: a project they rejected has nothing to rewrite.
 */
async function buildStage(item: IdentityProject, folder: string, lines: string[]): Promise<boolean> {
  const before = projectFiles(item.root);
  const printed: string[] = [];
  const capture = (chunk: string | Uint8Array): boolean => { printed.push(Buffer.from(chunk).toString()); return true; };
  const outside = process.cwd();
  process.chdir(item.root);
  mock.method(process.stdout, 'write', capture);
  mock.method(process.stderr, 'write', capture);
  let status: string;
  try {
    status = `exit ${(await runBuild({ watch: false, config: path.join(item.root, 'golem.yaml') })).exitCode}`;
  } catch (error) {
    status = 'threw';
    lines.push(describeError('build', error));
  } finally {
    mock.restoreAll();
    process.chdir(outside);
  }
  write(path.join(folder, BUILD_LOG), `${status}\n${printed.join('')}`.replaceAll(item.root, '<root>'));
  const generated = generatedFiles(item.root);
  for (const relative of generated) write(path.join(folder, GENERATED, relative), fs.readFileSync(path.join(item.root, relative)));
  for (const [relative, content] of projectFiles(item.root)) {
    if (!generated.has(relative) && !before.get(relative)?.equals(content)) write(path.join(folder, BUILT, relative), content);
  }
  return generated.size > 0;
}

function write(filename: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

async function run(projects: readonly IdentityProject[], outputDirectory: string, begin: (name: string) => void): Promise<void> {
  for (const item of projects) {
    begin(item.name);
    const lines: string[] = [];
    const folder = path.join(outputDirectory, caseFolder(item.name));
    const generated = isBuilt(item) && await buildStage(item, folder, lines);
    // A specifier case holds no model for the generators and a rewrite case holds its companions as fixtures; every other case is scanned after its build wrote the generated files into the project, and a rejected generation leaves nothing to scan.
    const edited = item.kind === 'specifiers' ? specifierStage(item, lines) : generated || item.kind === 'rewrite' ? rewriteStage(item, lines) : new Map<string, string>();
    for (const [relative, text] of edited) write(path.join(folder, REWRITTEN, relative), text);
    write(path.join(folder, DIAGNOSTICS), lines.map(line => `${line.replaceAll(item.root, '<root>')}\n`).join(''));
  }
}

const [projectsFile, outputDirectory] = process.argv.slice(2);
if (!projectsFile || !outputDirectory) throw new Error('usage: identity-generate <projects.json> <output directory>');

// The seam's own version, so the test can tell which TypeScript each child ran.
process.stdout.write(`typescript ${typescriptVersion}\n`);

const projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8')) as readonly IdentityProject[];
let current = '<none>';
try {
  await run(projects, outputDirectory, name => { current = name; });
} catch (error) {
  // Outside the per-stage catch: this child's own fault, so it ends non-zero and names the case it was in.
  process.stderr.write(`identity-generate failed in the case ${current}:\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
