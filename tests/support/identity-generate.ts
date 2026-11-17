import { generatorSettings } from './mobx-extension.js';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { generate as generateControllers } from '#ts-openapi/generator';
import { generate as generateModels } from '#model/generator';
import { runBuild } from '#golem/build';
import { applyRewrites } from '#golem/rewrite';
import { scanProject } from '#golem/rewrite-scan';
import { typescriptVersion } from '#golem/typescript-ns';
import type { GolemDiagnostic } from '#golem/generator-api';
import { writeGeneratedArtifacts } from '../fixture-project.js';
import { NEST_PARTICIPANTS } from '../fixture-templates/controllers/project.js';
import { editProjectSources } from './node-specifiers-project.js';
import { BUILD_LOG, BUILT, caseFolder, DIAGNOSTICS, GENERATED, isBuilt, REWRITTEN, type IdentityProject } from './identity-corpus.js';
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

/** The generator's files, or undefined when it rejected the project. */
async function generateStage(item: IdentityProject, lines: string[]): Promise<readonly { readonly path: string; readonly content: string }[] | undefined> {
  try {
    const result = item.kind === 'model'
      ? generateModels({ root: item.root, ...generatorSettings({ mobx: item.mobx, validation: true }) })
      : await generateControllers({
        root: item.root,
        output: path.join(item.root, 'openapi.json'),
        info: { title: 'Catalog', version: '1' },
        globalPrefix: 'api',
        uriVersioning: { type: 'URI', prefix: 'v' },
        profile: { validation: false },
      });
    for (const diagnostic of result.diagnostics ?? []) lines.push(describeDiagnostic('generate', diagnostic));
    return result.artifacts;
  } catch (error) {
    lines.push(describeError('generate', error));
    return undefined;
  }
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
      participants: item.kind === 'controller' ? NEST_PARTICIPANTS.error : [],
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

/**
 * `golem build` on the project, run in this process with the project as the working directory: its exit code (or the error it ended in) and
 * what it printed go to the build log, and each file it wrote or changed in the project goes under `built/`. The generate stage already wrote
 * the generated files, so a file that the build generated differently shows here too.
 */
async function buildStage(item: IdentityProject, folder: string): Promise<void> {
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
    status = describeError('build', error);
  } finally {
    mock.restoreAll();
    process.chdir(outside);
  }
  write(path.join(folder, BUILD_LOG), `${status}\n${printed.join('')}`.replaceAll(item.root, '<root>'));
  for (const [relative, content] of projectFiles(item.root)) {
    if (!before.get(relative)?.equals(content)) write(path.join(folder, BUILT, relative), content);
  }
}

function write(filename: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

async function run(projects: readonly IdentityProject[], outputDirectory: string, begin: (name: string) => void): Promise<void> {
  for (const item of projects) {
    begin(item.name);
    const lines: string[] = [];
    // A rewrite case's companions are fixtures; the other cases write their generated files into the project, where the scan reads them.
    const artifacts = item.kind === 'rewrite' || item.kind === 'specifiers' ? [] : await generateStage(item, lines);
    const folder = path.join(outputDirectory, caseFolder(item.name));
    // A rejected generation leaves nothing to rewrite.
    if (artifacts) {
      writeGeneratedArtifacts(artifacts);
      for (const artifact of artifacts) write(path.join(folder, GENERATED, path.relative(item.root, artifact.path)), artifact.content);
      for (const [relative, text] of item.kind === 'specifiers' ? specifierStage(item, lines) : rewriteStage(item, lines)) write(path.join(folder, REWRITTEN, relative), text);
    }
    write(path.join(folder, DIAGNOSTICS), lines.map(line => `${line.replaceAll(item.root, '<root>')}\n`).join(''));
    if (isBuilt(item)) await buildStage(item, folder);
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
