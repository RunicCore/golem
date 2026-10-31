import fs from 'node:fs';
import path from 'node:path';
import { generate as generateControllers } from '#controllers/generator';
import { generate as generateModels } from '#model/generator';
import { applyRewrites } from '#golem/rewrite';
import { scanProject } from '#golem/rewrite-scan';
import { typescriptVersion } from '#golem/typescript-ns';
import type { GolemDiagnostic } from '#golem/generator-api';
import { writeGeneratedArtifacts } from '../fixture-project.js';
import { editProjectSources } from './node-specifiers-project.js';
import { caseFolder, DIAGNOSTICS, GENERATED, REWRITTEN, type IdentityProject } from './identity-corpus.js';

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
      ? generateModels({ root: item.root, profile: { mobx: item.mobx, validation: true } })
      : await generateControllers({
        root: item.root,
        output: path.join(item.root, 'openapi.json'),
        info: { title: 'Catalog', version: '1' },
        globalPrefix: 'api',
        uriVersioning: { type: 'URI', prefix: 'v' },
        profile: { mobx: false, validation: false },
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
      directory: item.root,
      modelsRoot: item.root,
      configFile: path.join(item.root, 'tsconfig.json'),
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

function write(filename: string, content: string): void {
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
