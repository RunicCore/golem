import type { IModel } from '@exprtlabs/golem/model';

export type TMetadata = IModel<{ source: string }>;
export type TPayment = IModel<{
  id: string;
  currency: 'VND' | 'USD';
  metadata: Record<string, string>;
  audit: TMetadata extends IModel<infer Fields> ? Fields : never;
}, { exact: true }>;
