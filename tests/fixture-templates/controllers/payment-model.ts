import { identifier, tsSource, type SourceFragment } from '../../source-template.js';

export function paymentModelSource(options: {
  readonly field: 'amount' | 'destination';
  readonly fieldType: 'number' | 'string';
}): SourceFragment {
  const fieldType = options.fieldType === 'number' ? tsSource`number` : tsSource`string`;
  return tsSource`import type { IModel } from '@exprtlabs/golem/model';

export type TPayment = IModel<{ ${identifier(options.field)}: ${fieldType} }>;
`;
}
