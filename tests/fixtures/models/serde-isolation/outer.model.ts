import type { IObject } from '@exprtlabs/golem/model';

export type TDeep = IObject<{ x: number; extra?: unknown }, { allowAny: true }>;
export type TInner = IObject<{ deep: TDeep }>;
export type TOuter = IObject<{ inner: TInner }>;
