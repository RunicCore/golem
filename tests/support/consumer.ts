import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { CodegenProfile } from '@exprtlabs/codegen/generator-api';
import { copyFixtureFile } from '../fixture-project.js';
import { copyMaintainedExample, type ExampleName } from '../../scripts/maintained-examples.js';
import { workspace } from './process.js';

/** Copy a maintained repository consumer, excluding installed/build artifacts. */
export function copyExample(root: string, name: ExampleName): void {
  copyMaintainedExample(workspace, root, name);
}

export function writeFixture(root: string, profile: CodegenProfile, includeModels = true): void {
  copyFixtureFile(root, 'packed/profile/api.json', 'api.json');
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  if (includeModels) copyFixtureFile(root, 'packed/profile/src/cart.model.ts', 'src/cart.model.ts');
  else fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  const configuration = [
    'version: 1',
    `mobx: ${profile.mobx}`,
    `validation: ${profile.validation}`,
    `ajvStandalone: ${profile.ajvStandalone ?? false}`,
    'openapi:',
    '  - input: api.json',
    '    output: sdk',
    '    name: Profile',
    ...(includeModels ? ['models:', '  root: .'] : []),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'runic-codegen.yaml'), configuration);
}

export function generatedCodecId(source: string, shortName: string): string {
  const escaped = shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`createObjectCodec\\("(${escaped}_[0-9a-f]{8})"`));
  if (!match) throw new Error(`Generated codec id for ${JSON.stringify(shortName)} is missing.`);
  return match[1];
}

export function generatedCodecIdFromRoot(root: string, shortName: string): string {
  return generatedCodecId(
    filesUnder(root)
      .filter((filename) => filename.endsWith('.generated.ts')
        || filename.endsWith('iobject-plugin-keys.ts')
        || (path.basename(path.dirname(filename)) === 'models' && /^_group-.*\.ts$/.test(path.basename(filename))))
      .map((filename) => fs.readFileSync(filename, 'utf8'))
      .join('\n'),
    shortName,
  );
}

export function assertExecutedConsumerTests(output: string, label: string): void {
  const metric = (name: string): number => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    assert.ok(match, `${label} must report its ${name} count in TAP output`);
    return Number(match[1]);
  };
  const tests = metric('tests');
  const passed = metric('pass');
  const failed = metric('fail');
  const cancelled = metric('cancelled');
  const skipped = metric('skipped');
  assert.ok(tests > 0 && passed > 0, `${label} must execute and pass at least one test`);
  assert.equal(failed, 0, `${label} must have no failures`);
  assert.equal(cancelled, 0, `${label} must have no cancellations`);
  assert.equal(skipped, 0, `${label} must have no skipped tests`);
  assert.equal(passed, tests, `${label} must pass every test it reports`);
}

export function filesUnder(root: string): string[] {
  const result: string[] = [];
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}
