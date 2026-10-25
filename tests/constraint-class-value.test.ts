import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createModelProject, buildModelProject, generatedModelFiles, writeModelGolemYaml } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tsSource } from './source-template.js';

const CODECS = `import type { Pattern } from '@exprtlabs/golem/tags';
import { Money } from './money.js';
export type Base64 = string & Pattern<'^[A-Za-z0-9+/]*={0,2}$'>;
export type HexText = string & Pattern<'^[0-9a-f]*$'>;
export function encodeBytes(value: Uint8Array): Base64 { return btoa(String.fromCharCode(...value)) as Base64; }
export function decodeBytes(value: Base64): Uint8Array { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
export function encodeHex(value: Uint8Array): HexText { return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('') as HexText; }
export function decodeHex(value: HexText): Uint8Array { return Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16)); }
export function encodeMoney(value: Money): string { return value.toString(); }
export function decodeMoney(value: string): Money { return Money.parse(value); }
`;
const MONEY = `export class Money {
  constructor(readonly cents: bigint) {}
  static parse(text: string): Money { return new Money(BigInt(text.replace('.', ''))); }
  toString(): string { const s = this.cents.toString().padStart(3, '0'); return \`\${s.slice(0, -2)}.\${s.slice(-2)}\`; }
}
`;
const IMPORTS = tsSource`import type { TSerde, Contains } from '@exprtlabs/golem/tags';
import type { Money } from './money.js';
import { encodeBytes, decodeBytes, encodeHex, decodeHex, encodeMoney, decodeMoney } from './codecs.js';
type Bytes = Uint8Array & TSerde<typeof encodeBytes, typeof decodeBytes>;
type Hex = Uint8Array & TSerde<typeof encodeHex, typeof decodeHex>;
type Price = Money & TSerde<typeof encodeMoney, typeof decodeMoney>;`;

function project(t: test.TestContext, fields: ReturnType<typeof tsSource>) {
  const made = createModelProject(t, { prefix: 'golem-constraint-class-value-', name: 'constraint-class-value', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(made.sourceRoot, 'codecs.ts'), CODECS);
  fs.writeFileSync(path.join(made.sourceRoot, 'money.ts'), MONEY);
  fs.writeFileSync(path.join(made.sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: IMPORTS, fields }).text);
  writeModelGolemYaml(made.root, { mobx: false, validation: true });
  return made;
}

test('constraint schemas of one class under two TSerde codecs keep their own wire validators', async t => {
  // protects: T-431 the tag-validator key told two serde codecs of one class apart
  const { root } = project(t, tsSource`bytes: Array<Bytes> & Contains<Bytes>; hex: Array<Hex> & Contains<Hex>`);
  await buildModelProject(root);
  const codecs = await import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js'))) as { parseTA: (text: string) => unknown };
  assert.doesNotThrow(() => codecs.parseTA('{"bytes":["AQID"],"hex":["0a0b"]}'));
  assert.throws(() => codecs.parseTA('{"bytes":["AQID"],"hex":["AQID"]}'), 'the hex list must not take the base64 text');
  assert.throws(() => codecs.parseTA('{"bytes":["***"],"hex":["0a0b"]}'), 'the base64 list must not take non-base64 text');
});

test('a class inside a constraint schema leaves the output the same from two checkout paths', async t => {
  // protects: T-431 generated output does not depend on the checkout directory
  const fields = tsSource`prices: Array<Price> & Contains<Price>; bytes: Array<Bytes> & Contains<Bytes>`;
  const outputs = [project(t, fields).root, project(t, fields).root];
  assert.notEqual(outputs[0], outputs[1]);
  for (const root of outputs) await buildModelProject(root);
  const read = (root: string) => [
    ...generatedModelFiles(root).map(({ path: filename, content }) => [path.relative(root, filename), content] as const),
    ['.golem/codec-keys.json', fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8')] as const,
  ];
  assert.deepEqual(read(outputs[0]!), read(outputs[1]!));
});
