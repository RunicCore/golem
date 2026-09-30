import fs from 'node:fs';
import path from 'node:path';

export interface CodecPackageOptions {
  readonly name: string;
  /** `exports` map written verbatim into package.json. */
  readonly exports: Readonly<Record<string, unknown>>;
  /** Files relative to the package root, written verbatim. */
  readonly files: Readonly<Record<string, string>>;
}

/** Write a hand-authored ESM package (package.json plus files) at `dir`. */
export function writeCodecPackage(dir: string, { name, exports, files }: CodecPackageOptions): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', exports }));
  for (const [relative, text] of Object.entries(files)) {
    const filename = path.join(dir, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, text);
  }
}

/** A count codec package (number model, decimal-string wire) declared in dist/*.d.ts. */
export const COUNT_DIST_FILES = {
  'dist/codecs.d.ts': `import type { Pattern } from '@exprtlabs/golem/tags';
export type CountWire = string & Pattern<'^-?\\\\d+$'>;
export declare function encodeCount(value: number): CountWire;
export declare function decodeCount(value: CountWire): number;
`,
  'dist/codecs.js': `export function encodeCount(value) { return value.toString(); }
export function decodeCount(value) { return Number(value); }
`,
  'dist/tags.d.ts': `import type { MaxLength, TSerde } from '@exprtlabs/golem/tags';
import type { encodeCount, decodeCount } from './codecs.js';
export type PkgVarchar<N extends number> = string & MaxLength<N>;
export type PkgCount = number & TSerde<typeof encodeCount, typeof decodeCount>;
`,
  'dist/tags.js': 'export {};\n',
} as const;
