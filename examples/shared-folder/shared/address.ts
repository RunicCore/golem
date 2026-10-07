import type { MinLength } from '@exprtlabs/golem/tags';

// A plain type: it needs no IObject alias to be a field of a model.
export type TAddress = {
  street: string;
  city: string & MinLength<1>;
};
