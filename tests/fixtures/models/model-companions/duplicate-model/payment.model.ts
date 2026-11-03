import type { IModel } from '@exprtlabs/golem/model';
export type TPayment = IModel<{ amount: number }>;
export type Payment = IModel<{ destination: string }>;
