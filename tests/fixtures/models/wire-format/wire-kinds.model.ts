import type { IModel, IObject } from '@exprtlabs/codegen/model';
import type { Maximum, MinLength, TValidation } from '@exprtlabs/codegen/tags';
import { isKnown } from './rules.js';
import { WireKindsBase } from './wire-kinds.model.generated.js';

export type TWireKinds = IModel<{
  code: `SKU-${string}`;
  flag: boolean & TValidation<typeof isKnown>;
  status: 'open' | 'closed';
  level: 1 | 2;
  label: string & MinLength<1>;
  count: number & Maximum<10>;
}>;

/** A tagged literal keeps its tag in WireFormat; see KNOWN_DRIFT in tests/wire-format.test.ts. */
export type TTaggedLiterals = IObject<{ status: ('open' | 'closed') & TValidation<typeof isKnown>; level: 1 & TValidation<typeof isKnown> }>;

export class WireKinds extends WireKindsBase {}
