import type { IModel } from '@exprtlabs/golem/model';

// An optional slot before a rest element, and an optional slot whose type is a union of two kinds.
export type TFlags = IModel<{
  optionalThenRest: [string, number?, ...boolean[]];
  union?: [a?: string | number];
}>;
