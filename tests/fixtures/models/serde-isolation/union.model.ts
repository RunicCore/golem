import type { IObject } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';

export type TEmail = IObject<{ kind: 'email'; address: string }>;
export type TPhone = IObject<{ kind: 'phone'; number: string }>;
export type TContact = IObject<{ value: (TEmail | TPhone) & Discriminator<'kind'> }>;
