import type { IObject } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import { isKnown } from './rules.js';

export type TTaggedLiterals = IObject<{ status: ('open' | 'closed') & TValidation<typeof isKnown>; level: 1 & TValidation<typeof isKnown> }>;
