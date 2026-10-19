import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { type TestContext } from 'node:test';
import { resolveTypeScript } from '#golem/typescript-version';
import { workspace } from './process.js';
import { writeFixture } from './consumer.js';

// Tests that count the TypeScript 7 compiler's server processes and sessions, which TypeScript 6 does not have, skip on this.
export const skipOnTypeScript6 = resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? process.cwd()).major === 6
  && 'TypeScript 6 runs no compiler server process';

/** A generation project in a temp directory: a model, an OpenAPI document and a golem.yaml that runs both, with the golem packages linked. */
export function generationWatchFixture(t: TestContext): { root: string; config: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-watch-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  for (const name of ['golem', 'golem-model', 'golem-openapi']) {
    fs.symlinkSync(path.join(workspace, 'packages', name), path.join(root, 'node_modules/@exprtlabs', name), 'dir');
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"watch-fixture","type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  const config = path.join(root, 'golem.yaml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(
    'validation: true\n',
    'validation: true\nallowAny: false\n',
  ));
  return { root, config };
}

export function compilerChildren(parent: number): number[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null && Number(match[2]) === parent && match[3].includes('--api'))
    .map(match => Number(match[1]));
}
