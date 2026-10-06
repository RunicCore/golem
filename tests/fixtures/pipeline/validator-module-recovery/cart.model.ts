import type { Minimum } from '@exprtlabs/golem/tags';
import type { IModel } from '@exprtlabs/golem/model';
import type { Money as WireMoney } from '../sdk/index.js';
export type TCart = IModel<{ money: WireMoney; note: string; count: number & Minimum<0> }>;
