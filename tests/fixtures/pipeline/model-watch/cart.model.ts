import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './external/types.js';
/* @golem-model-manifest ./external/model-manifest.json */
export type TCart = IModel<{ money: Money }>;
