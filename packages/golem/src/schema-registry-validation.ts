import type { Validator } from './validation-runtime.js';

/** The validators of one operation: its input, the body of each response, keyed `<status>:<content type>`, and its response headers. */
export interface OperationRuntimeValidators {
  readonly input: Validator;
  /** Checks the header parameters of a call, which `input` leaves out; an override without it leaves them unchecked. */
  readonly requestHeaders?: Validator;
  readonly responses: ReadonlyMap<string, Validator>;
  /** Checks the wire form of each declared response header, keyed `<status>:<name>`; an override without it leaves them unchecked. */
  readonly responseHeaders?: ReadonlyMap<string, Validator>;
}
