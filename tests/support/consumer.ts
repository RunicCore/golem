import fs from 'node:fs';
import path from 'node:path';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { copyFixtureFile } from '../fixture-project.js';

export function writeFixture(root: string, profile: GolemProfile, includeModels = true): void {
  copyFixtureFile(root, 'packed/profile/api.json', 'api.json');
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  if (includeModels) copyFixtureFile(root, 'packed/profile/src/cart.model.ts', 'src/cart.model.ts');
  else fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  const configuration = [
    'version: 1',
    `mobx: ${profile.mobx}`,
    `validation: ${profile.validation}`,
    'openapi:',
    '  - input: api.json',
    '    output: sdk',
    '    name: Profile',
    ...(includeModels ? ['models:', '  root: .'] : []),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'golem.yaml'), configuration);
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
        || (path.basename(path.dirname(filename)) === 'models' && /^_group-.*\.ts$/.test(path.basename(filename))))
      .map((filename) => fs.readFileSync(filename, 'utf8'))
      .join('\n'),
    shortName,
  );
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
