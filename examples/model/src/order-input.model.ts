// #region nested-field-errors
import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';
import { OrderInputBaseModel } from './order-input.model.generated.js';

export type TOrderInput = IModel<{
  items: Array<{ sku: string & MinLength<3> }>;
}>;
export class OrderInput extends OrderInputBaseModel {}

export async function checkOrderInput() {
  const order = new OrderInput({ items: [{ sku: 'x' }] });
  const issues = await validateInstance(order);
  console.log(issues[0]?.path); // ['items', 0, 'sku']

  const validator = getValidator(order);
  await validator.validate();
  const skuError = validator.error(['items', 0, 'sku']);
  console.log(skuError); // 'must NOT have fewer than 3 characters'

  order.items = [{ sku: 'SKU' }];
  const fixedCount = (await validateInstance(order)).length;
  console.log(fixedCount); // 0

  return { firstIssuePath: issues[0]?.path, skuError, fixedCount };
}
// #endregion nested-field-errors
