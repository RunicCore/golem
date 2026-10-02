import * as serde from '@exprtlabs/golem/serde';
import { parse as decode } from '@exprtlabs/golem/serde';
import { parse as fromIndex, stringify as writeIndex } from './index.js';
import type { TMoney } from './payment.model.js';

declare const money: TMoney;
declare const text: string;
export const namespaced = serde.stringify<TMoney>(money);
export const aliased = decode<TMoney>(text);
export const reexported = fromIndex<TMoney>(text);
export const reexportedStar = writeIndex<TMoney>(money);
