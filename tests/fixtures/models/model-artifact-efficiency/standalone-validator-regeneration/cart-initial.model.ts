import type { IModel } from '@exprtlabs/golem/model';
import type { Minimum, TValidation } from '@exprtlabs/golem/tags';
export function acceptsCount(value: number): boolean { return value % 2 === 0; }
export type TCart = IModel<{ count: number & Minimum<1> & TValidation<typeof acceptsCount> }>;
