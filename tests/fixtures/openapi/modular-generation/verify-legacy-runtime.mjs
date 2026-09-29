
    import { Purchase } from './dist/purchase.model.js';
    import { OrderModel, LineItemModel } from './dist/index.js';
    import { getValidator } from '@exprtlabs/codegen/validation';

    const validOrder = new OrderModel({ id: 'ORD-1', lines: [new LineItemModel({ sku: 'sku-1', quantity: 1 })] });
    const validValidator = getValidator(new Purchase({ order: validOrder }));
    if (await validValidator.validate({ failFast: true }) !== true) {
      throw new Error('legacy runtime validator rejected valid nested model data');
    }

    const invalidOrder = new OrderModel({ id: '', lines: [new LineItemModel({ sku: 'x', quantity: 0 })] });
    const invalidValidator = getValidator(new Purchase({ order: invalidOrder }));
    if (await invalidValidator.validate({ failFast: false }) !== false) {
      throw new Error('legacy runtime validator accepted invalid nested model data');
    }
    if (!invalidValidator.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(['order', 'lines', 0, 'sku']))) {
      throw new Error('legacy runtime validator did not report the nested order.lines[0].sku issue');
    }
  