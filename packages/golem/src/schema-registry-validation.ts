import type { Validator } from './validation-runtime.js';

/** The validators of one operation: its input and the body of each response, keyed `<status>:<content type>`. */
export interface OperationRuntimeValidators {
  readonly input: Validator;
  /** Checks the header parameters of a call, which `input` leaves out; an override without it leaves them unchecked. */
  readonly requestHeaders?: Validator;
  readonly responses: ReadonlyMap<string, Validator>;
}
