import type { IObject } from '@exprtlabs/golem/model';

export type TBag = IObject<{}, { exact: false }>;
export type TShelfOfBag = IObject<{ bag: TBag }>;
