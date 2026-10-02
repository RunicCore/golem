import type { IObject } from '@exprtlabs/golem/model';

export type TEmail = IObject<{ kind: 'email'; address: string }>;
export type TPhone = IObject<{ kind: 'phone'; number: string }>;
export type TContact = IObject<{ value: TEmail | TPhone }>;
