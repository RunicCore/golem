// The SDK-model claims of WireFormat<T>, and the JSON that toWireFormat and the generated encoders produce at runtime.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import { command } from './support/process.js';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { assertWireClaimBuilds, wireClaimProject, type WireClaim } from './support/wire-claim-project.js';
import { modelCodec } from './support/model-codec.js';

interface SdkWireClaim extends WireClaim {
  /** An OpenAPI document in the fixture; its SDK is generated with this mobx setting, and the models job uses the same one. */
  readonly spec: string;
  readonly mobx: boolean;
}

const SDK_CLAIMS: readonly SdkWireClaim[] = [
  { claim: 'a model that uses an SDK model, and the SDK model class and fields', fixture: 'sdk-money', spec: 'money.yaml', mobx: false },
  { claim: 'nested and omitted-field SDK models without mobx', fixture: 'nested-sdk', spec: 'payments.yaml', mobx: false },
  { claim: 'nested and omitted-field SDK models with mobx', fixture: 'nested-sdk', spec: 'payments.yaml', mobx: true },
];

for (const { claim, fixture, spec, mobx } of SDK_CLAIMS) {
  test(`WireFormat<T> equals the emitted JSON type: ${claim}`, async t => {
    const { root, sourceRoot } = wireClaimProject(t, fixture, mobx);
    writeGeneratedArtifacts((await generateOpenApi({
      input: path.join(sourceRoot, spec),
      output: path.join(sourceRoot, 'sdk'),
      name: 'Payments',
      profile: { mobx, validation: true },
    })).artifacts);
    await assertWireClaimBuilds(root);
  });
}

test('toWireFormat<T> returns the emitted JSON type through the golem rewrite without a cast', async t => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-wire-format-call-',
    name: 'wire-format-call',
    linkWorkspaceNodeModules: true,
  });
  writeModelSources(sourceRoot, {
    'payment-editor.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Minimum } from '@exprtlabs/golem/tags';
import { TPaymentEditorBaseModel } from './payment-editor.model.generated.js';

export type TPaymentEditor = IModel<{ amount: number & Minimum<0>; note: string; paidAt: Date }>;

export class PaymentEditor extends TPaymentEditorBaseModel {
  public get summary(): string {
    return \`\${this.amount}: \${this.note}\`;
  }
}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  writeModelSources(sourceRoot, {
    'main.ts': `import { toWireFormat } from '@exprtlabs/golem/serde';
import { PaymentEditor, type TPaymentEditor } from './payment-editor.model.js';
import type { TPaymentEditorJSON } from './payment-editor.model.generated.js';

const editor = new PaymentEditor({ amount: 30, note: 'Lunch', paidAt: new Date('2026-01-02T03:04:05.000Z') });
const wire: TPaymentEditorJSON = toWireFormat<TPaymentEditor>(editor);
const fromClass = toWireFormat<PaymentEditor>(editor);
const paidAt: string = fromClass.paidAt;
// @ts-expect-error summary is a model getter, not a wire field.
void fromClass.summary;
// @ts-expect-error paidAt is an ISO string on the wire.
const paidAtDate: Date = toWireFormat<TPaymentEditor>(editor).paidAt;
void paidAtDate;
console.log(JSON.stringify({ wire, paidAt }));
`,
  });
  await buildModelProject(root);
  const result = await command(root, process.execPath, [path.join(root, 'build/main.js')]);
  assert.deepEqual(JSON.parse(result.stdout), {
    wire: { amount: 30, note: 'Lunch', paidAt: '2026-01-02T03:04:05.000Z' },
    paidAt: '2026-01-02T03:04:05.000Z',
  });
});

test('wire output omits optional fields that are absent or undefined', async t => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-wire-format-optional-',
    name: 'wire-format-optional',
    linkWorkspaceNodeModules: true,
  });
  writeModelSources(sourceRoot, {
    'visit.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TSlotBaseModel, TVisitBaseModel } from './visit.model.generated.js';

export type TSlot = IModel<{ at: Date; room?: string }>;
export type TVisit = IModel<{
  at: Date;
  note?: string;
  slot?: TSlot;
  detail?: { at: Date; memo?: string };
  window?: Partial<Pick<TSlot, 'at' | 'room'>>;
}>;
export class Slot extends TSlotBaseModel {}
export class Visit extends TVisitBaseModel {}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const generated = await import(pathToFileURL(path.join(root, 'build/visit.model.generated.js')).href) as {
    readonly toWireFormatTVisit: (value: unknown) => Record<string, unknown>;
    readonly stringifyTVisit: (value: unknown) => string;
  };
  const { Visit } = await import(pathToFileURL(path.join(root, 'build/visit.model.js')).href) as {
    readonly Visit: new (values: object) => object;
  };
  const at = new Date('2026-01-02T03:04:05.000Z');
  const encoders = [
    ['toWireFormat', generated.toWireFormatTVisit],
    ['model codec toWireFormat', (value: unknown) => modelCodec(Visit).toWireFormat(value as never) as Record<string, unknown>],
  ] as const;
  const visits = [
    ['absent', new Visit({ at, detail: { at }, window: {} })],
    ['undefined', new Visit({ at, note: undefined, slot: undefined, detail: { at, memo: undefined }, window: { at: undefined, room: undefined } })],
  ] as const;
  for (const [encoderName, encode] of encoders) {
    for (const [visitName, visit] of visits) {
      const label = `${encoderName}, ${visitName}`;
      const wire = encode(visit);
      assert.deepEqual(Object.keys(wire), ['at', 'detail', 'window'], label);
      assert.deepEqual(Object.keys(wire.window as object), [], `${label}: projection`);
      // A nested plain object keeps an authored undefined key; an absent one stays absent.
      if (visitName === 'absent') assert.deepEqual(Object.keys(wire.detail as object), ['at'], `${label}: nested object`);
      assert.equal(JSON.stringify(wire), generated.stringifyTVisit(visit), `${label}: matches stringify`);
    }
  }
});
