import type { IModel } from '@exprtlabs/golem/model';

export type TOwner = IModel<{ pet: { name: string; born: Date } | { bark: boolean; born: Date } }>;
