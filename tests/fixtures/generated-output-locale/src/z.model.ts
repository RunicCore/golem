import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde, TValidation } from '@exprtlabs/golem/tags';
import type { readZ, writeZ } from './codecs.js';
import type { validateZ } from './validators.js';

export type TZ = IModel<{
  b: 'z' | 'b' | 'aa';
  aa: boolean;
  weight: number & TSerde<typeof writeZ, typeof readZ> & TValidation<typeof validateZ>;
}>;
