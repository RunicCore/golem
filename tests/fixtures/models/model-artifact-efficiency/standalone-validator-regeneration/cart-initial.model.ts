import type { IModel } from '@exprtlabs/golem/model';
import type { Minimum, TValidation } from '@exprtlabs/golem/tags';
import type { acceptsCount } from './rules.js';
export type TCart = IModel<{ count: number & Minimum<1> & TValidation<typeof acceptsCount> }>;
