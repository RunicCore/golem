import type { IObject } from '@exprtlabs/golem/model';

export type TLeaf = IObject<{ x: number }>;
export type TMiddle = IObject<{ leaf: TLeaf; tags: string[] }>;
export type TTop = IObject<{ middle: TMiddle }>;
