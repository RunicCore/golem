import './missing';
import '#internal';
import 'https://example.com/lib.js';
import './frag#ment';
import { view } from './view';
import { esm } from './esm.mjs';
import { esm as esmFromTs } from './esm.mts';
import { cjs } from './cjs.cts';
import { thing as spelled } from 'plain/helpers/thing.js';
import { rootValue } from '../index';

export const edges = [view, esm, esmFromTs, cjs, rootValue, spelled];
