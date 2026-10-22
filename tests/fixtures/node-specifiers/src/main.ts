import './setup';
import '@lib/boot';
import { x } from './x';
import { dirValue } from './dir';
import { dirValue as slashDirValue } from './dir/';
import { siblingValue } from './sub/a';
import { tsNamedValue } from './ts-named.ts';
import { id } from '@lib/ids';
import { id as exactId } from '@ids';
import { alreadyValue } from './already.js';
import { legacyValue } from './legacy';
import { chain } from './reexport';
import type { Money } from './types';
import type { DeclOnly } from './decl-only';
import type { Shape } from '@lib/shapes';
import plain from 'plain';
import { thing } from 'plain/helpers/thing';
import { debounce } from 'lodashy/debounce';
import { folderValue } from 'plain/folder';
import { kitUtil } from '@scoped/kit/deep/util';
import { feature } from 'guarded/feature';
import { nestedThing } from 'guarded/nested/thing';

const { lazyValue } = await import('./lazy');
const { lazy2Value } = await import /* a comment before the parenthesis */ ('./lazy2');
const money: Money = { amount: 1 };
const declared: DeclOnly = { label: 'declared' };
const shape: Shape = { sides: 3 };

console.log([
  x, dirValue, siblingValue, tsNamedValue, id, alreadyValue, legacyValue, chain, plain, thing, folderValue, kitUtil, feature,
  nestedThing, lazyValue, money.amount, declared.label, shape.sides, slashDirValue, exactId, debounce, (globalThis as { setupRan?: boolean }).setupRan, lazy2Value, (globalThis as { bootRan?: boolean }).bootRan,
].join(','));
