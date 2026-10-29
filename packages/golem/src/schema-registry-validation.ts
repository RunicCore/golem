import type { Validator } from './validation-runtime.js';

/** The validators of one operation: its input and the body of each response, keyed `<status>:<content type>`. */
export interface OperationRuntimeValidators {
  readonly input: Validator;
  readonly responses: ReadonlyMap<string, Validator>;
}
