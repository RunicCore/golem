import type { IModel } from '@exprtlabs/codegen/model';
export type TPayment = IModel<{ amount: number }>;
export type Payment = IModel<{ destination: string }>;
