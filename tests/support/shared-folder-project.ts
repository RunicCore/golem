// Two apps that include one shared folder of plain types, and declare their own models over them.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { createModelProject } from '../model-project.js';
import { writeGeneratedArtifacts } from '../fixture-project.js';
import { command } from './process.js';

export interface SharedFolderProject {
  /** The directory that holds the linked packages the apps and the shared folder resolve. */
  readonly outer: string;
  /** The shared folder: a folder with a package.json that sets only the module type, plain types with a constraint, and no golem.yaml. */
  readonly shared: string;
  /** `outer/a`: `mobx` and `validation` on. It declares `TMoney` and `TOrder` over the shared types and calls `toWireFormat`. */
  readonly appA: string;
  /** `outer/apps/deep/b`: `mobx` and `validation` off. It declares `TMoney` and only calls `parse<TMoney>()`. */
  readonly appB: string;
}

/** The wire value of the order that app A's site encodes. */
export const ORDER_WIRE = { total: { currency: 'USD', value: '5' }, payment: { id: 'p1', amount: { currency: 'EUR', value: '7' }, priced: { currency: 'EUR' } } } as const;

const MONEY = `import type { MinLength } from '@exprtlabs/golem/tags';

export type TMoneyFields = { currency: string & MinLength<3>; value: string };
`;

/** App A: the order has a `TMoney` field and a `TPayment` field, and both are the app's own models over the shared plain type. */
const ORDER = (toShared: string): string => `import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { TMoneyFields } from '${toShared}/src/money.js';
import { TOrderBaseModel } from './order.model.generated.js';

export type TMoney = IObject<TMoneyFields>;
export type TPayment = IModel<{ id: string; amount: TMoney; priced: Omit<TMoney, 'value'> }>;
export type TOrder = IModel<{ total: TMoney; payment: TPayment }>;
export class Order extends TOrderBaseModel {}
`;

function relativeSpecifier(from: string, to: string): string {
  const relative = path.relative(from, to).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

const SITE_A = `import { parse, toWireFormat } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import { isComputedProp } from 'mobx';
import { Order } from './order.model.js';

const order = new Order({ total: { currency: 'USD', value: '5' }, payment: { id: 'p1', amount: { currency: 'EUR', value: '7' }, priced: { currency: 'EUR' } } });
export const wire = toWireFormat<Order>(order);
/** The MobX validator hook of the layer makes the validity of the order observable. */
export const validityObservable: boolean = isComputedProp(getValidator(order), 'valid');
export const parseShortCurrency = (): Order => parse<Order>('{"total":{"currency":"US","value":"5"},"payment":{"id":"p1","amount":{"currency":"EUR","value":"7"},"priced":{"currency":"EUR"}}}');
`;

/** App B: its own `TMoney` over the shared plain type. */
const MONEY_B = (toShared: string): string => `import type { IObject } from '@exprtlabs/golem/model';
import type { TMoneyFields } from '${toShared}/src/money.js';

export type TMoney = IObject<TMoneyFields>;
`;

const SITE_B = `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './money.model.js';
import './money.model.generated.js';

export const parseShortCurrency = (): TMoney => parse<TMoney>('{"currency":"US","value":"5"}');
`;

function writeApp(app: string, shared: string, name: string, profile: string, sources: (toShared: string) => Readonly<Record<string, string>>): void {
  const toShared = relativeSpecifier(path.join(app, 'src'), shared);
  const toOuter = relativeSpecifier(app, path.dirname(shared));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name, private: true, type: 'module', dependencies: { '@exprtlabs/golem': '*', '@exprtlabs/golem-model': '*', '@exprtlabs/golem-openapi-ts': '*' } }),
    'golem.yaml': `version: 1\n${profile}model: {}\n`,
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, declaration: true, sourceMap: true, outDir: 'build', rootDir: toOuter },
      include: ['src/**/*.ts', `${relativeSpecifier(app, shared)}/src/**/*.ts`],
    }),
    ...sources(toShared),
  };
  for (const [relative, text] of Object.entries(files)) writeGeneratedArtifacts([{ path: path.join(app, relative), content: text }]);
}

/**
 * `outer/shared` (plain types with a constraint, a package.json without a name, no golem.yaml), app A at `outer/a` and app B at
 * `outer/apps/deep/b`. Nothing is generated yet. Neither app has configuration for the shared folder.
 */
export function sharedFolderProject(t: TestContext, name: string): SharedFolderProject {
  const { root: outer } = createModelProject(t, { prefix: 'golem-shared-folder-', name, linkWorkspaceNodeModules: true });
  const shared = path.join(outer, 'shared');
  const appA = path.join(outer, 'a');
  const appB = path.join(outer, 'apps/deep/b');
  writeGeneratedArtifacts([
    { path: path.join(shared, 'package.json'), content: JSON.stringify({ type: 'module' }) },
    { path: path.join(shared, 'src/money.ts'), content: MONEY },
  ]);
  writeApp(appA, shared, 'app-a', 'validation: true\nopenapi-ts:\n  extensions:\n    mobx: {}\n', (toShared) => ({ 'src/order.model.ts': ORDER(toShared), 'src/site.ts': SITE_A }));
  writeApp(appB, shared, 'app-b', 'validation: false\n', (toShared) => ({ 'src/money.model.ts': MONEY_B(toShared), 'src/site.ts': SITE_B }));
  return { outer, shared, appA, appB };
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
