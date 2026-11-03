import type { IModel } from '@exprtlabs/golem/model';
import type { MaxLength, Pattern, TSerde, TValidation } from '@exprtlabs/golem/tags';
import type { readAa, writeAa } from './codecs.js';
import type { TB } from './b.model.js';
import type { TZ } from './z.model.js';
import type { validateAa } from './validators.js';

export type TAa = IModel<{
  z: TZ;
  b: TB;
  aa: string & Pattern<'aa'> & MaxLength<8> & TValidation<typeof validateAa>;
  rate: number & TSerde<typeof writeAa, typeof readAa>;
}>;
