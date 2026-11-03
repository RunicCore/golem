import type { IModel } from '@exprtlabs/golem/model';
import type { Maximum, Pattern } from '@exprtlabs/golem/tags';

export type TB = IModel<{
  z: number & Maximum<9>;
  aa: string & Pattern<'z'>;
}>;
