// Two apps that include one shared folder of models: the fixture of the shared-model-folder acceptance tests.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { createModelProject } from '../model-project.js';
import { writeGeneratedArtifacts } from '../fixture-project.js';
import { command } from './process.js';

export interface SharedFolderProject {
  /** The directory that holds the linked packages the apps and the shared folder resolve. */
  readonly outer: string;
  /** The shared folder: a package with a name and no golem.yaml. */
  readonly shared: string;
  /** `outer/a`: `mobx` and `validation` on. It nests `TMoney` and calls `toWireFormat`. */
  readonly appA: string;
  /** `outer/apps/deep/b`: `mobx` and `validation` off. It only calls `parse<TMoney>()`. */
  readonly appB: string;
}

/** The wire value of the order that app A's site encodes. */
export const ORDER_WIRE = { total: { currency: 'USD', value: '5' }, payment: { id: 'p1', amount: { currency: 'EUR', value: '7' }, priced: { currency: 'EUR' } } } as const;

/** The shared companions the two apps write, relative to the shared folder. */
export const SHARED_COMPANIONS = ['src/money.model.generated.ts', 'src/payment.model.generated.ts'] as const;

const MONEY = `import type { IObject } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';

export type TMoney = IObject<{ currency: string & MinLength<3>; value: string }>;
`;

const PAYMENT = `import type { IModel } from '@exprtlabs/golem/model';
import type { TMoney } from './money.model.js';

export type TPayment = IModel<{ id: string; amount: TMoney; priced: Omit<TMoney, 'value'> }>;
`;

/** App A: the order has a `TMoney` field and a `TPayment` field. */
const ORDER = (toShared: string): string => `import type { IModel } from '@exprtlabs/golem/model';
import type { TMoney } from '${toShared}/src/money.model.js';
import type { TPayment } from '${toShared}/src/payment.model.js';
import { TOrderBaseModel } from './order.model.generated.js';

export type TOrder = IModel<{ total: TMoney; payment: TPayment }>;
export class Order extends TOrderBaseModel {}
`;

function relativeSpecifier(from: string, to: string): string {
  const relative = path.relative(from, to).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

const SITE_A = (toShared: string): string => `import { parse, toWireFormat } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import { isComputedProp } from 'mobx';
import { Order } from './order.model.js';
import '${toShared}/src/money.model.generated.js';
import '${toShared}/src/payment.model.generated.js';

const order = new Order({ total: { currency: 'USD', value: '5' }, payment: { id: 'p1', amount: { currency: 'EUR', value: '7' }, priced: { currency: 'EUR' } } });
export const wire = toWireFormat<Order>(order);
/** The MobX validator hook of the layer makes the validity of the order observable. */
export const validityObservable: boolean = isComputedProp(getValidator(order), 'valid');
export const parseShortCurrency = (): Order => parse<Order>('{"total":{"currency":"US","value":"5"},"payment":{"id":"p1","amount":{"currency":"EUR","value":"7"},"priced":{"currency":"EUR"}}}');
`;

const SITE_B = (toShared: string): string => `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from '${toShared}/src/money.model.js';
import '${toShared}/src/money.model.generated.js';

export const parseShortCurrency = (): TMoney => parse<TMoney>('{"currency":"US","value":"5"}');
`;

function writeApp(app: string, shared: string, name: string, profile: string, sources: (toShared: string) => Readonly<Record<string, string>>): void {
  const toShared = relativeSpecifier(path.join(app, 'src'), shared);
  const toOuter = relativeSpecifier(app, path.dirname(shared));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name, private: true, type: 'module' }),
    'golem.yaml': `version: 1\n${profile}models:\n  root: .\n`,
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, declaration: true, sourceMap: true, outDir: 'build', rootDir: toOuter },
      include: ['src/**/*.ts', `${relativeSpecifier(app, shared)}/src/**/*.ts`],
    }),
    ...sources(toShared),
  };
  for (const [relative, text] of Object.entries(files)) writeGeneratedArtifacts([{ path: path.join(app, relative), content: text }]);
}

/**
 * `outer/shared` (a named package with a `TMoney` object and a `TPayment` model, no golem.yaml), app A at `outer/a` and app B at
 * `outer/apps/deep/b`. Nothing is generated yet. Neither app has configuration for the shared folder.
 */
export function sharedFolderProject(t: TestContext, name: string): SharedFolderProject {
  const { root: outer } = createModelProject(t, { prefix: 'golem-shared-folder-', name, linkWorkspaceNodeModules: true });
  const shared = path.join(outer, 'shared');
  const appA = path.join(outer, 'a');
  const appB = path.join(outer, 'apps/deep/b');
  writeGeneratedArtifacts([
    { path: path.join(shared, 'package.json'), content: JSON.stringify({ name: '@fixture/shared-models', type: 'module' }) },
    { path: path.join(shared, 'src/money.model.ts'), content: MONEY },
    { path: path.join(shared, 'src/payment.model.ts'), content: PAYMENT },
  ]);
  writeApp(appA, shared, 'app-a', 'mobx: true\nvalidation: true\n', (toShared) => ({ 'src/order.model.ts': ORDER(toShared), 'src/site.ts': SITE_A(toShared) }));
  writeApp(appB, shared, 'app-b', 'mobx: false\nvalidation: false\n', (toShared) => ({ 'src/site.ts': SITE_B(toShared) }));
  return { outer, shared, appA, appB };
}

/** The text of every shared companion, by its path from the shared folder. */
export function sharedCompanions(project: SharedFolderProject): Readonly<Record<string, string>> {
  return Object.fromEntries(SHARED_COMPANIONS.map((relative) => [relative, fs.readFileSync(path.join(project.shared, relative), 'utf8')]));
}

/** The codec ids of the app's key table, by key. */
export function codecKeys(app: string): Readonly<Record<string, string>> {
  return (JSON.parse(fs.readFileSync(path.join(app, '.golem/codec-keys.json'), 'utf8')) as { keys: Record<string, string> }).keys;
}

/** What the `site` module of an app does under Node, as `runSite` reports it. */
export interface SiteOutcome {
  /** The wire value of app A's order. */
  readonly wire: unknown;
  /** Whether the MobX validator hook made the validity of app A's order observable. */
  readonly validityObservable: boolean | null;
  /** The value that the parse of a currency shorter than three characters returned. */
  readonly accepted: unknown;
  /** The message of the error that parse threw. */
  readonly rejected: string | null;
}

/** Imports `site` (a JavaScript file or, with the loader flags, a TypeScript file) in a child Node, calls its short-currency parse and reports the outcome. */
export async function runSite(app: string, site: string, flags: readonly string[] = []): Promise<SiteOutcome> {
  const script = `import(${JSON.stringify(pathToFileURL(site).href)}).then((site) => { let rejected = null, accepted = null; try { accepted = site.parseShortCurrency(); } catch (error) { rejected = error.message; } console.log(JSON.stringify({ wire: site.wire ?? null, validityObservable: site.validityObservable ?? null, accepted, rejected })); });`;
  const result = await command(app, process.execPath, [...flags, '--input-type=module', '--eval', script]);
  return JSON.parse(result.stdout) as SiteOutcome;
}
