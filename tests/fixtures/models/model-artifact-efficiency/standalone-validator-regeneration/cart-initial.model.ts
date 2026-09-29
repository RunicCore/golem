import type { IModel } from '@exprtlabs/codegen/model';
import type { Minimum, TValidation } from '@exprtlabs/codegen/tags';
export function acceptsCount(value: number): boolean { return value % 2 === 0; }
export type TCart = IModel<{ count: number & Minimum<1> & TValidation<typeof acceptsCount> }>;
